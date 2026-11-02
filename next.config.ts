import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  experimental: {
    // Phosphor ships one module per icon. Load only the icons in use.
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  turbopack: {
    rules: {
      // Tailwind compiles only the app's own CSS. next/font's generated CSS (a Next internal) must
      // skip it, or next dev fails to resolve the font URLs.
      "*.css": {
        condition: { not: "foreign" },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
