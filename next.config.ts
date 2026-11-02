import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev indicator sits over the corner of Catch up in the 360 x 480 Windows panel.
  devIndicators: false,
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
