import { getDocument, GlobalWorkerOptions } from "./vendor/pdfjs/pdf.mjs";
GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
export async function openPDF(blob, container) {
  let task,
    render,
    closed = false;
  const close = () => {
    closed = true;
    render?.cancel();
    task?.destroy().catch(() => {});
  };
  container.pdfCleanup = close;
  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    if (closed) return;
    task = getDocument({
      data,
      isEvalSupported: false,
      maxImageSize: 16000000,
      canvasMaxAreaInBytes: 16000000,
      useWasm: true,
      wasmUrl: "/vendor/pdfjs/wasm/",
      cMapUrl: "/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    });
    const pdf = await task.promise;
    if (closed) return;
    const controls = document.createElement("div");
    controls.className = "pdf-controls actions";
    const previous = document.createElement("button"),
      next = document.createElement("button"),
      label = document.createElement("span"),
      canvas = document.createElement("canvas"),
      text = document.createElement("p");
    previous.textContent = "Previous page";
    next.textContent = "Next page";
    previous.className = next.className = "secondary compact";
    canvas.setAttribute("aria-label", "PDF page preview");
    text.className = "visually-hidden";
    controls.append(previous, label, next);
    container.replaceChildren(controls, canvas, text);
    let number = 1,
      busy = false;
    async function draw() {
      busy = true;
      previous.disabled = next.disabled = true;
      try {
        const page = await pdf.getPage(number);
        if (closed) return;
        const normal = page.getViewport({ scale: 1 });
        const scale = Math.min(
          2,
          Math.max(300, container.clientWidth - 16) / normal.width,
        );
        const density = Math.min(devicePixelRatio || 1, 2);
        // Cap a single page to four megapixels to bound phone canvas memory.
        const viewport = page.getViewport({
          scale: Math.min(
            scale * density,
            Math.sqrt(4000000 / (normal.width * normal.height)),
          ),
        });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        label.textContent = "Page " + number + " of " + pdf.numPages;
        render = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
        });
        await render.promise;
        const content = await page.getTextContent();
        if (closed) return;
        text.textContent = content.items
          .map((item) => item.str || "")
          .join(" ");
        text.setAttribute("aria-label", "Text on page " + number);
        page.cleanup();
        canvas.dataset.rendered = String(number);
      } finally {
        busy = false;
        previous.disabled = number <= 1;
        next.disabled = number >= pdf.numPages;
      }
    }
    previous.onclick = () => {
      if (!busy && number > 1) {
        number--;
        draw().catch(failed);
      }
    };
    next.onclick = () => {
      if (!busy && number < pdf.numPages) {
        number++;
        draw().catch(failed);
      }
    };
    function failed() {
      if (!closed)
        container.textContent =
          "This PDF could not be previewed. Download it to open it on your device.";
    }
    await draw();
  } catch {
    if (!closed)
      container.textContent =
        "This PDF could not be previewed. Download it to open it on your device.";
  }
}
