import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
// Wide-axis Archivo for display and body (font-stretch 100–125%), Space Mono for figures,
// Mrs Saint Delafield for the red venue script.
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/mrs-saint-delafield/400.css";
import "./styles.css";

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
