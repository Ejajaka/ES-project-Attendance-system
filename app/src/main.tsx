import { registerRootComponent } from "expo";
import App from "./App";

// NativeWind: Tailwind stylesheet must be imported before the root component.
import "../global.css";

registerRootComponent(App);
