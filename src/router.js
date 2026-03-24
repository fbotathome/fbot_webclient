function navigate(pageId) {
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
}
