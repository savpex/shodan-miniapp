FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8091
ENV DATA_DIR=/tmp/shodan-data

EXPOSE 8091

CMD ["python", "server.py"]
