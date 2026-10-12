// Vercel serves its free analytics endpoints; the Cloudflare fallback stays independently usable.
if (location.hostname.endsWith(".vercel.app")) {
  window.va =
    window.va ||
    function (...args) {
      (window.vaq = window.vaq || []).push(args);
    };
  window.va("beforeSend", (event) => ({
    ...event,
    url: new URL(event.url).origin + new URL(event.url).pathname,
  }));
  const script = document.createElement("script");
  script.src = "/_vercel/insights/script.js";
  script.defer = true;
  document.head.append(script);
}
