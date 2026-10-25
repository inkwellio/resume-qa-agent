import { XProvider } from "@ant-design/x";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { theme } from "./theme";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少根节点");

createRoot(root).render(
  <StrictMode>
    <ConfigProvider theme={theme} locale={zhCN} button={{ autoInsertSpace: false }}>
      <AntApp>
        <XProvider>
          <App />
        </XProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
