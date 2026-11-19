#!/usr/bin/env bash
# =============================================================================
# scripts/build_android_ndk28.sh
# Builds stock llama.cpp v1.0.0 rpc-server as 16 KB page-aligned PIE executable
# (librpc_server_exec.so) for Android arm64-v8a (API 28..36) using NDK r28,
# and cross-compiles clusterd for aarch64-linux-android.
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLAMA_CPP_TAG="${LLAMA_CPP_TAG:-v1.0.0}"
ANDROID_ABI="arm64-v8a"
ANDROID_PLATFORM="android-28"
NDK_ROOT="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"

if [[ -z "${NDK_ROOT}" || ! -d "${NDK_ROOT}" ]]; then
  echo "[ERROR] ANDROID_NDK_HOME or ANDROID_NDK_ROOT must point to Android NDK r28+" >&2
  exit 1
fi

TOOLCHAIN="${NDK_ROOT}/toolchains/llvm/prebuilt/linux-x86_64"
if [[ ! -d "${TOOLCHAIN}" ]]; then
  TOOLCHAIN="$(find "${NDK_ROOT}/toolchains/llvm/prebuilt" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
fi

BUILD_DIR="${ROOT_DIR}/build/android-ndk28-${ANDROID_ABI}"
LLAMA_SRC_DIR="${ROOT_DIR}/build/llama.cpp-${LLAMA_CPP_TAG}"
JNI_OUT_DIR="${ROOT_DIR}/app/src/main/jniLibs/${ANDROID_ABI}"
mkdir -p "${BUILD_DIR}" "${JNI_OUT_DIR}"

if [[ ! -d "${LLAMA_SRC_DIR}" ]]; then
  echo "[1/5] Fetching stock llama.cpp (${LLAMA_CPP_TAG})..."
  git clone --depth 1 --branch "${LLAMA_CPP_TAG}" https://github.com/ggml-org/llama.cpp.git "${LLAMA_SRC_DIR}" || \
    git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "${LLAMA_SRC_DIR}"
fi

# 16 KB ELF Page Alignment (0x4000 = 16384) for Android 15/16 (API 35/36) compatibility
# Baseline ARMv8.0-A (-march=armv8-a) + GGML_CPU_ALL_VARIANTS=ON for runtime HWCAP dispatch
COMMON_LDFLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -pie -fPIE"

echo "[2/5] Configuring llama.cpp rpc-server with NDK r28 (${ANDROID_PLATFORM}, 16 KB page alignment)..."
cmake -S "${LLAMA_SRC_DIR}" -B "${BUILD_DIR}" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="${NDK_ROOT}/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="${ANDROID_ABI}" \
  -DANDROID_PLATFORM="${ANDROID_PLATFORM}" \
  -DANDROID_STL="c++_static" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-march=armv8-a -O3 -fPIE" \
  -DCMAKE_CXX_FLAGS="-march=armv8-a -O3 -fPIE" \
  -DCMAKE_EXE_LINKER_FLAGS="${COMMON_LDFLAGS}" \
  -DCMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384" \
  -DGGML_RPC=ON \
  -DGGML_CPU_ALL_VARIANTS=ON \
  -DGGML_OPENMP=OFF \
  -DBUILD_SHARED_LIBS=OFF

echo "[3/5] Compiling rpc-server target..."
cmake --build "${BUILD_DIR}" --target rpc-server -j"$(nproc)"

RPC_BIN="$(find "${BUILD_DIR}" -type f -name "rpc-server" | head -n 1)"
if [[ -z "${RPC_BIN}" || ! -f "${RPC_BIN}" ]]; then
  echo "[ERROR] rpc-server binary not found after build" >&2
  exit 1
fi

OUT_SO="${JNI_OUT_DIR}/librpc_server_exec.so"
cp -f "${RPC_BIN}" "${OUT_SO}"
"${TOOLCHAIN}/bin/llvm-strip" --strip-unneeded "${OUT_SO}"
chmod 0755 "${OUT_SO}"

echo "[4/5] Verifying 16 KB ELF Page Alignment (0x4000) & Bionic-only dependencies..."
READELF="${TOOLCHAIN}/bin/llvm-readelf"
"${READELF}" -l "${OUT_SO}" | grep -E "LOAD|0x4000|0x0+4000"
if ! "${READELF}" -l "${OUT_SO}" | grep -qE "0x0*4000"; then
  echo "[ERROR] ELF LOAD segment is not 16 KB (0x4000) aligned!" >&2
  exit 1
fi

NEEDED_LIBS="$("${READELF}" -d "${OUT_SO}" | grep "NEEDED" || true)"
echo "${NEEDED_LIBS}"
if echo "${NEEDED_LIBS}" | grep -qE "libpthread\.so|librt\.so|glibc"; then
  echo "[ERROR] Forbidden non-Bionic dependency detected in librpc_server_exec.so!" >&2
  exit 1
fi

echo "[5/5] Cross-compiling clusterd for aarch64-linux-android..."
if [[ -f "${ROOT_DIR}/clusterd/Cargo.toml" ]] && command -v cargo >/dev/null 2>&1; then
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="${TOOLCHAIN}/bin/aarch64-linux-android28-clang"
  export CC_aarch64_linux_android="${TOOLCHAIN}/bin/aarch64-linux-android28-clang"
  export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384"
  (
    cd "${ROOT_DIR}/clusterd"
    cargo build --release --target aarch64-linux-android
  )
  cp -f "${ROOT_DIR}/clusterd/target/aarch64-linux-android/release/clusterd" \
        "${JNI_OUT_DIR}/libclusterd_worker_exec.so"
  chmod 0755 "${JNI_OUT_DIR}/libclusterd_worker_exec.so"
fi

echo "[SUCCESS] Packaged 16 KB aligned ${OUT_SO} for Android API 28..36 (Zero Root)."
