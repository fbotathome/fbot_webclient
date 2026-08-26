import { initDashboard, destroyDashboard } from "./pages/dashboardPage.js";
import {
  initManipulator,
  destroyManipulator,
} from "./pages/manipulatorPage.js";
import { initVision, destroyVision } from "./pages/visionPage.js";
import { initEmotions, destroyEmotions } from "./pages/emotionsPage.js";
import { initSpeech, destroySpeech } from "./pages/speechPage.js";
import { initLabeler, destroyLabeler } from "./pages/labelerPage.js";

const pageHandlers = {
  dashboard: { init: initDashboard, destroy: destroyDashboard },
  manipulator: { init: initManipulator, destroy: destroyManipulator },
  vision: { init: initVision, destroy: destroyVision },
  emotions: { init: initEmotions, destroy: destroyEmotions },
  speech: { init: initSpeech, destroy: destroySpeech },
  labeler: { init: initLabeler, destroy: destroyLabeler },
};

let currentPage = null;

function navigate(pageId) {
  if (currentPage === pageId) return;

  if (currentPage && pageHandlers[currentPage]?.destroy) {
    pageHandlers[currentPage].destroy();
  }

  const pages = document.querySelectorAll(".page");
  pages.forEach((p) => p.classList.remove("active"));

  const target = document.getElementById("page-" + pageId);
  if (target) {
    target.classList.add("active");
  }

  const links = document.querySelectorAll(".menu a");
  links.forEach((link) => {
    link.classList.toggle("active", link.dataset.page === pageId);
  });

  const title = document.getElementById("page-title");
  if (title) {
    title.textContent = pageId.charAt(0).toUpperCase() + pageId.slice(1);
  }

  if (pageHandlers[pageId]?.init) {
    pageHandlers[pageId].init();
  }

  currentPage = pageId;
}

export function initRouter() {
  const menu = document.querySelector(".menu");
  if (!menu) return;

  menu.addEventListener("click", (e) => {
    const link = e.target.closest("a[data-page]");
    if (!link) return;

    e.preventDefault();
    navigate(link.dataset.page);
  });

  const firstActiveLink = document.querySelector(".menu a.active");
  if (firstActiveLink) {
    navigate(firstActiveLink.dataset.page);
  } else {
    navigate("dashboard");
  }
}
