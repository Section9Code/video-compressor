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

    async boot() {
      this.$watch('view', (v) => { location.hash = `#/${v}`; });
      this.settings = await this.json('/api/settings');
      this.tree = await this.loadDirs('', 0);
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
      const i = this.tree.findIndex((n) => n.path === p);
      const node = this.tree[i];
      if (node && !node.open) {
        const children = await this.loadDirs(p, node.depth + 1);
        node.open = true;
        this.tree.splice(i + 1, 0, ...children);
      }

      this.scanPath = p;
      this.scanning = true;
      this.selected = new Set();
      try {
        const { files } = await this.json(`/api/scan?path=${encodeURIComponent(p)}`);
        this.files = files;
        this.selectAllReducible();
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
      await this.json('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [...this.selected] }),
      });
      this.selected = new Set();
      await this.scanDir(this.scanPath);
      this.view = 'queue';
      this.poll();
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
