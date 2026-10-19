# LibreSprite (GPL-2.0) built from source, run headless behind a stdio MCP bridge.
# Build: docker build -t libresprite-mcp .
ARG BUN_VERSION=1.4.3

FROM debian:trixie AS build
ARG LIBRESPRITE_COMMIT=2be695f986ee210cb6bd0c210093b6f08686717f
ARG CMAKE_VERSION=4.4.3
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      curl git ca-certificates g++ ninja-build libfreetype6-dev libgif-dev libgtest-dev libjpeg-dev \
      libpixman-1-dev libpng-dev libsdl2-dev libsdl2-image-dev libtinyxml2-dev libwebp-dev libx11-dev \
      libxcursor-dev libnode-dev zlib1g-dev libarchive-dev
# trixie's apt cmake is 3.31; LibreSprite needs >= 4.1
RUN curl -fsSL "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-$(uname -m).tar.gz" \
      | tar -xz -C /usr/local --strip-components=1
RUN git init -q /src && cd /src \
 && git fetch -q --depth 1 https://github.com/LibreSprite/LibreSprite "${LIBRESPRITE_COMMIT}" \
 && git checkout -q FETCH_HEAD && git submodule update -q --init --recursive --depth 1
RUN cmake -S /src -B /src/build -G Ninja -DCMAKE_BUILD_TYPE=Release && ninja -C /src/build libresprite \
 && mkdir /opt/libresprite && cp -r /src/build/bin/libresprite /src/build/bin/data /opt/libresprite/

FROM oven/bun:${BUN_VERSION} AS bun

FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive
# The binary's direct shared-library dependencies (readelf NEEDED), mapped to trixie packages.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      libarchive13t64 libfreetype6 libgif7 libjpeg62-turbo libpixman-1-0 libpng16-16t64 libsdl2-2.0-0 \
      libsdl2-image-2.0-0 libssl3t64 libtinyxml2-11 libwebp7 libxcb1 libxi6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /opt/libresprite /opt/libresprite
COPY bridge.js /opt/bridge.js
COPY test /opt/test
WORKDIR /work
ENTRYPOINT ["bun", "/opt/bridge.js"]
