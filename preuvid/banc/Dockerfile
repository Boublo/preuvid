# Image du banc : générateur, client et calcul des scores.
# Versions figées pour que les images synthétiques soient identiques d'une
# machine à l'autre (polices DejaVu de Debian, Pillow, OpenCV, NumPy).
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-dejavu-core \
    curl \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
    pillow==12.2.0 \
    numpy==2.4.6 \
    opencv-python-headless==4.13.0.92
ENV PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1
WORKDIR /banc
COPY gen.py run.py score.py compare.py ./
