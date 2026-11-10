import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/console.css";
import "./styles/materials.css";
import "./styles/components.css";
import "./styles/instruments.css";
import "./styles/layout.css";
import "./styles/pages.css";

createApp(App).use(createPinia()).use(router).mount("#app");
