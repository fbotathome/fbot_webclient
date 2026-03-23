function navegar(event, pageId) {
  if (event) event.preventDefault();

  const paginas = document.querySelectorAll(".page");
  paginas.forEach((p) => {
    p.classList.remove("active");
    p.style.display = "none";
  });

  const paginaAlvo = document.getElementById("page-" + pageId);
  if (paginaAlvo) {
    paginaAlvo.classList.add("active");
    paginaAlvo.style.display = "contents";
  }

  const botoes = document.querySelectorAll(".menu a");
  botoes.forEach((b) => b.classList.remove("active"));

  if (event) {
    event.currentTarget.classList.add("active");
  }

  const tituloHeader = document.getElementById("page-title");
  if (tituloHeader) {
    tituloHeader.innerText = pageId.charAt(0).toUpperCase() + pageId.slice(1);
  }
}
