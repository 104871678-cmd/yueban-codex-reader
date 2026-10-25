// File hashing runs away from the UI thread and never sends file content online.
self.onmessage = async ({ data: { file } }) => {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const key = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
    self.postMessage({ key });
  } catch(error) { self.postMessage({ error: error.message }); }
};
