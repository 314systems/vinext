import type { NextConfig } from "vinext";

const config: NextConfig = {
  images: {
    maximumResponseBody: 100,
    minimumCacheTTL: 123,
  },
};

export default config;
