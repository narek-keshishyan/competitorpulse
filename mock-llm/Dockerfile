FROM python:3.13-alpine
WORKDIR /app
COPY mock-llm-server.py .
ENV PORT=4001 PYTHONUNBUFFERED=1
EXPOSE 4001
CMD ["python3", "mock-llm-server.py"]
