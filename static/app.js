/* S.H.O.D.A.N. Terminal v3 — Multi-image, Think, Search */
(function () {
    "use strict";

    // ── Telegram WebApp integration ──────────────────────────────────────
    const tg = window.Telegram && window.Telegram.WebApp;
    const initData = (tg && tg.initData) || "";
    if (tg) {
        tg.ready();
        tg.expand();
        tg.setHeaderColor("#191919");
        tg.setBackgroundColor("#191919");
    }

    // ── DOM elements ─────────────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const chatMessages = $("#chat-messages");
    const chatInput = $("#chat-input");
    const sendBtn = $("#send-btn");
    const photoBtn = $("#photo-btn");
    const photoInput = $("#photo-input");
    const photoPreview = $("#photo-preview");
    const previewStrip = $("#preview-strip");
    const clearPhotosBtn = $("#clear-photos");
    const voiceBtn = $("#voice-btn");
    const tokenCount = $("#token-count");
    const thinkToggle = $("#think-toggle");
    const searchToggle = $("#search-toggle");
    const apiKeyInput = $("#api-key-input");
    const toggleKey = $("#toggle-key");
    const saveKeyBtn = $("#save-key-btn");
    const deleteKeyBtn = $("#delete-key-btn");
    const keyStatus = $("#key-status");
    const clearMemoryBtn = $("#clear-memory-btn");
    const modelSelect = $("#model-select");
    const eulaToggle = $("#eula-toggle");
    const eulaBody = $("#eula-body");
    const eulaArrow = $("#eula-arrow");

    // State
    let photos = []; // array of { base64, dataUrl }
    const MAX_PHOTOS = 10;
    let isProcessing = false;
    let hasKey = false;
    let thinkEnabled = false;
    let searchEnabled = false;

    // ── API helper ───────────────────────────────────────────────────────
    const API_BASE = "";

    async function api(endpoint, body = {}) {
        body.initData = initData;
        const resp = await fetch(API_BASE + endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok) {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        return data;
    }

    // ── Tab switching ────────────────────────────────────────────────────
    $$(".tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            $$(".tab").forEach((t) => t.classList.remove("active"));
            $$(".tab-content").forEach((c) => c.classList.remove("active"));
            tab.classList.add("active");
            const target = tab.dataset.tab;
            $(`#tab-${target}`).classList.add("active");
            if (target === "stats") loadStats();
        });
    });

    // ── Chat ─────────────────────────────────────────────────────────────

    function addMessage(role, text, meta) {
        const div = document.createElement("div");
        div.className = `message ${role}`;
        const textSpan = document.createElement("span");
        textSpan.className = "msg-text";
        textSpan.textContent = text;
        div.appendChild(textSpan);
        if (meta) {
            const metaSpan = document.createElement("span");
            metaSpan.className = "msg-meta";
            metaSpan.textContent = meta;
            div.appendChild(metaSpan);
        }
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return div;
    }

    function addTypingIndicator() {
        const div = document.createElement("div");
        div.className = "message assistant";
        div.id = "typing-indicator";
        div.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return div;
    }

    function removeTypingIndicator() {
        const el = $("#typing-indicator");
        if (el) el.remove();
    }

    function updateSendButton() {
        const hasText = chatInput.value.trim().length > 0;
        sendBtn.disabled = isProcessing || (!hasText && photos.length === 0);
    }

    chatInput.addEventListener("input", () => {
        updateSendButton();
        chatInput.style.height = "auto";
        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
    });

    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!sendBtn.disabled) sendMessage();
        }
    });

    sendBtn.addEventListener("click", sendMessage);

    async function sendMessage() {
        if (isProcessing) return;

        const text = chatInput.value.trim();
        if (!text && photos.length === 0) return;
        if (!hasKey) {
            addMessage("error", "> ERROR: Configure API key in Settings first.");
            return;
        }

        isProcessing = true;
        updateSendButton();

        // Save photos BEFORE clearing
        const photoDataArr = photos.map((p) => p.base64);
        const photoCount = photos.length;

        // Show user message
        let displayText = text || "";
        if (photoCount > 0) {
            displayText += (displayText ? " " : "") + `[${photoCount} image${photoCount > 1 ? "s" : ""}]`;
        }
        addMessage("user", displayText);

        // Clear input
        chatInput.value = "";
        chatInput.style.height = "auto";
        clearAllPhotos();

        // Show typing
        addTypingIndicator();

        try {
            const body = {};
            if (text) body.message = text;
            if (photoDataArr.length > 0) body.images = photoDataArr;
            if (!photoDataArr.length) body.model = modelSelect.value;
            if (thinkEnabled) body.think = true;
            if (searchEnabled) body.search = true;

            console.log("[SHODAN] Sending:", {
                hasText: !!text,
                photos: photoDataArr.length,
                think: thinkEnabled,
                search: searchEnabled,
            });

            const result = await api("/api/chat", body);

            removeTypingIndicator();
            addMessage("assistant", result.content, result.tokens_used ? `${result.tokens_used} tokens` : null);

            if (result.usage) {
                updateTokenBadge(result.usage.monthly, result.usage.monthly_limit);
            }
        } catch (err) {
            removeTypingIndicator();
            addMessage("error", "> " + err.message);
        } finally {
            isProcessing = false;
            updateSendButton();
        }
    }

    // ── Multi-photo handling ─────────────────────────────────────────────

    photoInput.addEventListener("change", (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;

        const remaining = MAX_PHOTOS - photos.length;
        if (remaining <= 0) {
            addMessage("system", `> Max ${MAX_PHOTOS} images allowed.`);
            photoInput.value = "";
            return;
        }

        const toProcess = files.slice(0, remaining);
        if (files.length > remaining) {
            addMessage("system", `> Only ${remaining} more image(s) can be added (max ${MAX_PHOTOS}).`);
        }

        toProcess.forEach((file) => {
            if (file.size > 5 * 1024 * 1024) {
                addMessage("error", `> File "${file.name}" too large (max 5MB). Skipped.`);
                return;
            }
            const reader = new FileReader();
            reader.onload = function (ev) {
                const dataUrl = ev.target.result;
                const idx = dataUrl.indexOf(",");
                if (idx < 0) return;
                const base64 = dataUrl.substring(idx + 1);
                photos.push({ base64, dataUrl });
                renderPhotoPreview();
                updateSendButton();
                console.log("[SHODAN] Photo added, total:", photos.length);
            };
            reader.readAsDataURL(file);
        });

        photoInput.value = "";
    });

    clearPhotosBtn.addEventListener("click", clearAllPhotos);

    function clearAllPhotos() {
        photos = [];
        renderPhotoPreview();
        updateSendButton();
    }

    function removePhotoAt(index) {
        photos.splice(index, 1);
        renderPhotoPreview();
        updateSendButton();
    }

    function renderPhotoPreview() {
        previewStrip.innerHTML = "";
        if (photos.length === 0) {
            photoPreview.hidden = true;
            return;
        }
        photoPreview.hidden = false;
        photos.forEach((p, i) => {
            const thumb = document.createElement("div");
            thumb.className = "preview-thumb";
            const img = document.createElement("img");
            img.src = p.dataUrl;
            const btn = document.createElement("button");
            btn.className = "thumb-remove";
            btn.textContent = "✕";
            btn.addEventListener("click", () => removePhotoAt(i));
            thumb.appendChild(img);
            thumb.appendChild(btn);
            previewStrip.appendChild(thumb);
        });
    }

    // ── Think & Search toggles ───────────────────────────────────────────

    thinkToggle.addEventListener("click", () => {
        thinkEnabled = !thinkEnabled;
        thinkToggle.classList.toggle("active", thinkEnabled);
    });

    searchToggle.addEventListener("click", () => {
        searchEnabled = !searchEnabled;
        searchToggle.classList.toggle("active", searchEnabled);
    });

    // ── Voice input (Web Speech API) ─────────────────────────────────────

    let recognition = null;
    let isRecording = false;

    if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.lang = "ru-RU";
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            chatInput.value += (chatInput.value ? " " : "") + text;
            chatInput.dispatchEvent(new Event("input"));
        };

        recognition.onend = () => {
            isRecording = false;
            voiceBtn.classList.remove("recording");
        };

        recognition.onerror = (event) => {
            isRecording = false;
            voiceBtn.classList.remove("recording");
            if (event.error === "network") {
                addMessage("system", "> Voice: network error. Try Chrome on Android or desktop.");
            } else if (event.error !== "no-speech" && event.error !== "aborted") {
                addMessage("system", `> Voice error: ${event.error}`);
            }
        };
    }

    voiceBtn.addEventListener("click", () => {
        if (!recognition) {
            addMessage("system", "> Voice input not supported in this browser.");
            return;
        }
        if (isRecording) {
            recognition.stop();
        } else {
            isRecording = true;
            voiceBtn.classList.add("recording");
            recognition.start();
        }
    });

    // ── Settings: API Key ────────────────────────────────────────────────

    toggleKey.addEventListener("click", () => {
        const isPassword = apiKeyInput.type === "password";
        apiKeyInput.type = isPassword ? "text" : "password";
        toggleKey.textContent = isPassword ? "🔒" : "👁";
    });

    saveKeyBtn.addEventListener("click", async () => {
        const key = apiKeyInput.value.trim();
        if (!key) {
            showKeyStatus("Enter your key first", "err");
            return;
        }
        try {
            await api("/api/key/save", { api_key: key });
            hasKey = true;
            apiKeyInput.value = "";
            showKeyStatus("Key saved and encrypted ✓", "ok");
        } catch (err) {
            showKeyStatus(err.message, "err");
        }
    });

    deleteKeyBtn.addEventListener("click", async () => {
        try {
            await api("/api/key/delete");
            hasKey = false;
            showKeyStatus("Key and chat memory deleted", "ok");
        } catch (err) {
            showKeyStatus(err.message, "err");
        }
    });

    function showKeyStatus(text, type) {
        keyStatus.textContent = text;
        keyStatus.className = `status-msg ${type}`;
        setTimeout(() => {
            keyStatus.textContent = "";
            keyStatus.className = "status-msg";
        }, 4000);
    }

    // ── Settings: Clear Memory ───────────────────────────────────────────

    clearMemoryBtn.addEventListener("click", async () => {
        try {
            await api("/api/memory/clear");
            const msgs = chatMessages.querySelectorAll(".message:not(:first-child)");
            msgs.forEach((m) => m.remove());
            addMessage("system", "> Memory cleared.");
        } catch (err) {
            addMessage("error", "> " + err.message);
        }
    });

    // ── EULA toggle ──────────────────────────────────────────────────────

    eulaToggle.addEventListener("click", () => {
        const isHidden = eulaBody.hidden;
        eulaBody.hidden = !isHidden;
        eulaArrow.classList.toggle("open", isHidden);
    });

    // ── Stats ────────────────────────────────────────────────────────────

    async function loadStats() {
        try {
            const stats = await api("/api/stats");
            $("#stat-monthly").textContent = stats.monthly.toLocaleString();
            $("#stat-monthly-limit").textContent = stats.monthly_limit.toLocaleString();
            const pct = Math.min((stats.monthly / stats.monthly_limit) * 100, 100);
            const bar = $("#bar-monthly");
            bar.style.width = pct + "%";
            bar.classList.toggle("over-limit", stats.monthly >= stats.monthly_limit);
            $("#stat-key-status").textContent = stats.has_key ? "Active ✓" : "Not set";
            $("#stat-key-status").style.color = stats.has_key ? "var(--accent)" : "var(--danger)";
            if (stats.limit_contact) {
                $("#stat-contact").textContent = stats.limit_contact;
            }
        } catch (err) {
            console.error("Stats load error:", err);
        }
    }

    // ── Token badge ──────────────────────────────────────────────────────

    function updateTokenBadge(used, limit) {
        if (used >= 1_000_000) {
            tokenCount.textContent = (used / 1_000_000).toFixed(1) + "M";
        } else if (used >= 1_000) {
            tokenCount.textContent = (used / 1_000).toFixed(0) + "K";
        } else {
            tokenCount.textContent = used;
        }
    }

    // ── Init: authenticate & restore memory ──────────────────────────────

    async function init() {
        if (!initData) {
            addMessage("system", "> Open this app via Telegram Mini App button.");
            return;
        }
        try {
            const auth = await api("/api/auth");
            hasKey = auth.has_key;

            if (auth.usage) {
                updateTokenBadge(auth.usage.monthly, auth.usage.monthly_limit);
            }

            if (auth.memory && auth.memory.length > 0) {
                auth.memory.forEach((msg) => {
                    addMessage(msg.role, msg.content);
                });
            }

            if (!hasKey) {
                addMessage("system", "> Configure your OpenRouter API key in Settings to start chatting.");
            }
        } catch (err) {
            addMessage("error", "> Auth failed: " + err.message);
        }
    }

    init();
})();
