import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { queryClient } from "@/client/lib/queryClient";
import { applyThemeClass } from "@/lib/theme";
import { App } from "./App";
import "../index.css";

// Re-stamp from the store's own resolution at boot — self-heals any divergence
// from the pre-paint inline script in index.html (e.g. storage-throwing browsers).
applyThemeClass();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Failed to find the root element");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
