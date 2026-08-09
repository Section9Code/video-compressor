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
    pollFailed: false,
    settingsError: null,
    schedule: { enabled: false, open: true, startHour: 2, endHour: 6 },

    async boot() {
      this.$watch('view', (v) => { location.hash = `#/${v}`; });
      this.error = null;
      try {
        this.settings = await this.json('/api/settings');
        // /api/browse only returns *sub*directories, so the root needs a node of its
        // own or videos sitting directly in MEDIA_ROOT can never be scanned. Named to
        // match the leading ROOT in the breadcrumb.
        this.tree = [
          { path: '', name: 'ROOT', depth: 0, open: true },
          ...await this.loadDirs('', 1),
        ];
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

    // Client-side so changing the target re-ticks (and re-dims) the list without a re-scan.
    reducible(f) {
      return Math.min(f.width, f.height) > this.settings.targetShortSide;
    },

    // Recomputed against the current target, so changing the setting re-ticks the list.
    selectAllReducible() {
      this.selected = new Set(
        this.files
          .filter((f) => !f.queued && !f.probeError && this.reducible(f))
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

    // Called bare from boot() and the interval, so it must never reject. It clears
    // only an error it raised itself: a recovering server stops nagging, but a scan
    // or save error the user has not read yet is not wiped two seconds later.
    async poll() {
      try {
        const body = await this.json('/api/jobs');
        this.jobs = body.jobs;
        this.schedule = body.schedule;
        if (this.pollFailed) {
          this.pollFailed = false;
          this.error = null;
        }
      } catch (err) {
        this.pollFailed = true;
        this.error = err.message;
      }
    },

    get pending() {
      return this.jobs.filter((j) => j.status === 'waiting');
    },

    get active() {
      return this.jobs.find((j) => j.status === 'processing') ?? null;
    },

    get archive() {
      return this.jobs
        .filter((j) => ['done', 'skipped', 'failed'].includes(j.status))
        .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0));
    },

    get totalSaved() {
      return this.jobs
        .filter((j) => j.status === 'done')
        .reduce((n, j) => n + (j.orig_size - j.new_size), 0);
    },

    savingPct(job) {
      if (!job.orig_size || !job.new_size) return 0;
      return Math.round((1 - job.new_size / job.orig_size) * 100);
    },

    // Extrapolated from percent alone: ffmpeg's own speed figure swings too much
    // early on to be worth reading, and this is honest about being an estimate.
    eta(job) {
      if (!job.progress || !job.duration) return '--:--';
      const elapsed = (Date.now() - (job.started_at ?? Date.now())) / 1000;
      if (!elapsed) return '--:--';
      const total = elapsed / (job.progress / 100);
      const left = Math.max(0, Math.round(total - elapsed));
      return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    },

    async removeJob(id) {
      this.error = null;
      try {
        await this.json(`/api/jobs/${id}`, { method: 'DELETE' });
        await this.poll();
      } catch (err) {
        this.error = err.message;
      }
    },

    async requeue(id) {
      this.error = null;
      try {
        await this.json(`/api/jobs/${id}/requeue`, { method: 'POST' });
        await this.poll();
      } catch (err) {
        this.error = err.message;
      }
    },

    fmtSize(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
      return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
    },

    hhmm(hour) {
      return `${String(hour).padStart(2, '0')}:00`;
    },

    get scheduleHeld() {
      return this.schedule.enabled && !this.schedule.open && this.pending.length > 0;
    },

    async saveSettings() {
      this.settingsError = null;
      try {
        this.settings = await this.json('/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.settings),
        });
        this.settingsOpen = false;
        // The target changed, so which files are worth queueing changed with it.
        if (this.files.length) this.selectAllReducible();
      } catch (err) {
        this.settingsError = err.message;
      }
    },
  };
}
