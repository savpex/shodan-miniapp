/* S.H.O.D.A.N. Mini App — Frontend Logic */
(function () {
    "use strict";

    // ── Telegram WebApp integration ──────────────────────────────────────
    const tg = window.Telegram && window.Telegram.WebApp;
    const initData = (tg && tg.initData) || "";
    if (tg) {
        tg.ready();
        tg.expand();
        tg.setHeaderColor("#0D1117");
        tg.setBackgroundColor("#0D1117");
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
    const previewImg = $("#preview-img");
    const removePhoto = $("#remove-photo");
    const voiceBtn = $("#voice-btn");
    const tokenCount = $("#token-count");
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
    let currentPhoto = null; // base64 string
    let isProcessing = false;
    let hasKey = false;

    // ── API helper ───────────────────────────────────────────────────────
    const API_BASE = "";  // Same origin

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
        sendBtn.disabled = isProcessing || (!hasText && !currentPhoto);
    }

    chatInput.addEventListener("input", () => {
        updateSendButton();
        // Auto-resize
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
        if (!text && !currentPhoto) return;
        if (!hasKey) {
            addMessage("error", "Please configure your API key in Settings first.");
            return;
        }

        isProcessing = true;
        updateSendButton();

        // Show user message
        const displayText = text || "[Photo]";
        addMessage("user", displayText);

        // Clear input
        chatInput.value = "";
        chatInput.style.height = "auto";
        clearPhoto();

        // Show typing
        addTypingIndicator();

        try {
            const body = {};
            if (text) body.message = text;
            if (currentPhoto) body.image = currentPhoto;
            body.model = modelSelect.value;

            const result = await api("/api/chat", body);

            removeTypingIndicator();
            addMessage("assistant", result.content, result.tokens_used ? `${result.tokens_used} tokens` : null);

            // Update token badge
            if (result.usage) {
                updateTokenBadge(result.usage.monthly, result.usage.monthly_limit);
            }
        } catch (err) {
            removeTypingIndicator();
            addMessage("error", err.message);
        } finally {
            isProcessing = false;
            currentPhoto = null;
            updateSendButton();
        }
    }

    // ── Photo handling ───────────────────────────────────────────────────

    photoBtn.addEventListener("click", () => photoInput.click());

    photoInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Resize image before sending (max 1024px, JPEG 85%)
        const reader = new FileReader();
        reader.onload = function (ev) {
            const img = new Image();
            img.onload = function () {
                const MAX = 1024;
                let w = img.width;
                let h = img.height;
                if (w > MAX || h > MAX) {
                    if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                    else { w = Math.round(w * MAX / h); h = MAX; }
                }
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
                currentPhoto = dataUrl.split(",")[1]; // Remove data:image/jpeg;base64, prefix

                previewImg.src = dataUrl;
                photoPreview.hidden = false;
                updateSendButton();
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        photoInput.value = "";
    });

    removePhoto.addEventListener("click", clearPhoto);

    function clearPhoto() {
        currentPhoto = null;
        previewImg.src = "";
        photoPreview.hidden = true;
        updateSendButton();
    }

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
            if (event.error !== "no-speech" && event.error !== "aborted") {
                addMessage("system", `Voice error: ${event.error}`);
            }
        };
    }

    voiceBtn.addEventListener("click", () => {
        if (!recognition) {
            addMessage("system", "Voice input is not supported in this browser.");
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
        toggleKey.innerHTML = isPassword ? "&#128064;" : "&#128065;";
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
            // Clear chat UI except  first system message
            const msgs = chatMessages.querySelectorAll(".message:not(:first-child)");
            msgs.forEach((m) => m.remove());
            addMessage("system", "Memory cleared.");
        } catch (err) {
            addMessage("error", err.message);
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
            addMessage("system", "Open this app via Telegram Mini App button.");
            return;
        }
        try {
            const auth = await api("/api/auth");
            hasKey = auth.has_key;

            // Update token badge
            if (auth.usage) {
                updateTokenBadge(auth.usage.monthly, auth.usage.monthly_limit);
            }

            // Restore memory to chat
            if (auth.memory && auth.memory.length > 0) {
                auth.memory.forEach((msg) => {
                    addMessage(msg.role, msg.content);
                });
            }

            if (!hasKey) {
                addMessage("system", "Configure your OpenRouter API key in Settings to start chatting.");
            }
        } catch (err) {
            addMessage("error", "Auth failed: " + err.message);
        }
    }

    init();
})();
