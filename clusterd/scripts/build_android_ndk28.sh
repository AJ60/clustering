#!/usr/bin/env bash
# Cross-compiles stock llama.cpp v1.0.0 (RPC v9) rpc-server for Android arm64-v8a
# using Android NDK r28 and Vulkan SDK 1.4 with 16 KB ELF page alignment.
set -euo pipefail

NDK_HOME="${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to Android NDK r28 path}"
VULKAN_SDK_INC="${VULKAN_SDK:-/opt/vulkan-sdk/1.4}/include"
LLAMA_DIR="${LLAMA_CPP_DIR:-./llama.cpp}"
BUILD_DIR="${BUILD_DIR:-./build-android-arm64}"
APK_JNILIBS="${APK_JNILIBS:-./android-apk/app/src/main/jniLibs/arm64-v8a}"

if [[ ! -d "$LLAMA_DIR" ]]; then
  git clone --depth 1 --branch v1.0.0 https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
fi

cmake -S "$LLAMA_DIR" -B "$BUILD_DIR" \
  -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK_HOME/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-29 \
  -DANDROID_STL=c++_static \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_RPC=ON \
  -DGGML_VULKAN=ON \
  -DGGML_OPENMP=ON \
  -DGGML_CPU_KLEIDIAI=ON \
  -DVulkan_INCLUDE_DIR="$VULKAN_SDK_INC" \
  -DCMAKE_C_FLAGS="-march=armv8.2-a+dotprod+fp16" \
  -DCMAKE_CXX_FLAGS="-march=armv8.2-a+dotprod+fp16" \
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,-z,max-page-size=16384 -static-openmp"

cmake --build "$BUILD_DIR" --target rpc-server -j"$(nproc)"

BIN="$BUILD_DIR/bin/rpc-server"
mkdir -p "$APK_JNILIBS"
cp "$BIN" "$APK_JNILIBS/librpc_server_exec.so"

echo "[VERIFY] Checking 16 KB ELF LOAD alignment (0x4000):"
readelf -l "$BIN" | grep -A1 "LOAD"

echo "[VERIFY] Checking NEEDED dynamic libraries (Bionic + libomp.so only):"
readelf -d "$BIN" | grep "NEEDED" || true
