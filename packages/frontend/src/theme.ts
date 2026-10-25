import type { ThemeConfig } from "antd";

const fontFamily =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';

/** 色值来自 Stitch 导出的 tailwind.config。主色比 antd 默认更深。 */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: "#0057c2",
    colorPrimaryHover: "#006ef2",
    colorPrimaryActive: "#004398",
    colorPrimaryBg: "#d9e2ff",
    colorInfo: "#0057c2",
    colorLink: "#0057c2",
    colorSuccess: "#216d00",
    colorError: "#ba1a1a",
    colorText: "#111c2a",
    colorTextSecondary: "#414755",
    colorTextTertiary: "#727786",
    colorBorder: "#c1c6d7",
    colorBgLayout: "#f8f9ff",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    borderRadius: 4,
    borderRadiusLG: 8,
    borderRadiusSM: 4,
    fontFamily,
    fontSize: 14,
    lineHeight: 22 / 14,
    controlHeight: 36,
    boxShadow: "0 1px 8px rgba(0, 0, 0, 0.04)",
    boxShadowSecondary: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  },
  components: {
    Button: {
      primaryShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
      defaultShadow: "none",
      fontWeight: 500,
      borderRadius: 12,
      defaultBorderColor: "transparent",
      defaultBg: "#ffffff",
      defaultColor: "#414755",
      defaultHoverBg: "#dee9fc",
      defaultHoverColor: "#111c2a",
      defaultHoverBorderColor: "transparent",
    },
    Input: {
      activeBorderColor: "#0057c2",
      hoverBorderColor: "#0057c2",
      activeShadow: "0 0 0 1px #0057c2",
      borderRadius: 12,
    },
    Modal: {
      borderRadiusLG: 12,
    },
    Popover: {
      borderRadiusLG: 12,
    },
    Radio: {
      colorPrimary: "#0057c2",
    },
  },
};
