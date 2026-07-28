import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: "category",
      label: "Getting Started",
      items: ["getting-started", "webhooks", "api-limits"],
    },
    {
      type: "category",
      label: "API Reference",
      items: ["api-reference", "smart-contract"],
    },
  ],
};

export default sidebars;
