FROM python:3.12.11-slim@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN pip install --no-cache-dir uv==0.8.22

COPY pyproject.toml uv.lock README.md ./
COPY staffing_solver ./staffing_solver
RUN uv sync --locked --no-dev --no-editable

ENV PATH="/app/.venv/bin:$PATH"

USER 65532:65532
EXPOSE 8080

CMD ["uvicorn", "staffing_solver.api:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
