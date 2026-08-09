function app() {
  return {
    view: location.hash === '#/queue' ? 'queue' : 'browse',
    settingsOpen: false,
    settings: {},
    tree: [],
    scanPath: null,
    scanning: false,
    files: [],
    selected: new Set(),
    jobs: [],
    error: null,

    async boot() {
      this.$watch('view', (v) => { location.hash = `#/${v}`; });
      this.error = null;
      try {
        this.settings = await this.json('/api/settings');
        this.tree = await this.loadDirs('', 0);
      } catch (err) {
        this.error = err.message;
      }
      this.poll();
      setInterval(() => { if (!document.hidden) this.poll(); }, 2000);
    },

    async json(url, options) {
      const res = await fetch(url, options);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      return body;
    },

    async loadDirs(p, depth) {
      const { dirs } = await this.json(`/api/browse?path=${encodeURIComponent(p)}`);
      return dirs.map((d) => ({ ...d, depth, open: false }));
    },

    // Lazily expand in place, so a deep tree is never walked up front.
    async scanDir(p) {
      this.error = null;
      const i = this.tree.findIndex((n) => n.path === p);
      const node = this.tree[i];
      if (node && !node.open) {
        // Flip open synchronously before the await: a second click on the same
        // node while this request is in flight then sees open === true and is
        // a no-op, instead of racing a duplicate splice at a stale index.
        node.open = true;
        try {
          const children = await this.loadDirs(p, node.depth + 1);
          this.tree.splice(i + 1, 0, ...children);
        } catch (err) {
          node.open = false;
          this.error = err.message;
          return;
        }
      }

      this.scanning = true;
      try {
        const { files } = await this.json(`/api/scan?path=${encodeURIComponent(p)}`);
        // Only commit path/files/selection once the scan succeeds, so a failed
        // scan doesn't leave the breadcrumb and the file list describing
        // different directories.
        this.scanPath = p;
        this.files = files;
        this.selected = new Set();
        this.selectAllReducible();
      } catch (err) {
        this.error = err.message;
      } finally {
        this.scanning = false;
      }
    },

    // Recomputed against the current target, so changing the setting re-ticks the list.
    selectAllReducible() {
      const target = this.settings.targetShortSide;
      this.selected = new Set(
        this.files
          .filter((f) => !f.queued && !f.probeError && Math.min(f.width, f.height) > target)
          .map((f) => f.path),
      );
    },

    toggle(f) {
      const next = new Set(this.selected);
      next.has(f.path) ? next.delete(f.path) : next.add(f.path);
      this.selected = next;
    },

    get selectedBytes() {
      return this.files.filter((f) => this.selected.has(f.path)).reduce((n, f) => n + f.size, 0);
    },

    get breadcrumbs() {
      return this.scanPath ? this.scanPath.split('/').filter(Boolean) : [];
    },

    get activeCount() {
      return this.jobs.filter((j) => j.status === 'waiting' || j.status === 'processing').length;
    },

    async addSelected() {
      this.error = null;
      try {
        await this.json('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: [...this.selected] }),
        });
        this.selected = new Set();
        await this.scanDir(this.scanPath);
        this.view = 'queue';
        this.poll();
      } catch (err) {
        this.error = err.message;
      }
    },

    async poll() {
      this.jobs = (await this.json('/api/jobs')).jobs;
    },

    fmtSize(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
      return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
    },
  };
}
