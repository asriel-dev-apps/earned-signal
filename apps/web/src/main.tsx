import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main>
      <p className="eyebrow">Project controls, clearly connected</p>
      <h1>EarnedSignal</h1>
      <p>
        Plan work, record actuals, and understand where the project is
        heading.
      </p>
    </main>
  );
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
