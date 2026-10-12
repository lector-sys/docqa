import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // onnxruntime ships native binaries and the model is fetched at runtime; bundling either
  // breaks the ask endpoint. Keep them as real node_modules on the server.
  serverExternalPackages: ["@xenova/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
