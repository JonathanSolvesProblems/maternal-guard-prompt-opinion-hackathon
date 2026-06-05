FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY maternal_dashboard_server.py .

ENV PORT=5001
ENV TRANSPORT=streamable-http
ENV HOST=0.0.0.0

EXPOSE 5001

CMD ["python", "maternal_dashboard_server.py"]
