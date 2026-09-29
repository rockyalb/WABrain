import { render } from "preact";
import { App } from "./app";
import "./styles.css";
import "./workspace.css";

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
