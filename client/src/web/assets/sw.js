// casty's service worker: a push from casty serve becomes a notification that names who spoke
// to you, and a tap on it opens mentions. The worker caches nothing: the page is tiny and
// casty web is on the same network or behind the same proxy as the node.
self.addEventListener("push", (event) => {
  let data = { title: "casty", url: "#/mentions" };
  try {
    data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      tag: "casty-mentions",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "#/mentions", self.location.origin).href;
  // The page that registered this worker is not under its control until a reload, and
  // navigate() refuses such a page: then a new window it is.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (!open) return self.clients.openWindow(url);
      return open
        .focus()
        .then((focused) => focused.navigate(url))
        .catch(() => self.clients.openWindow(url));
    }),
  );
});
