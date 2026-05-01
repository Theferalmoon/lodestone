// SPDX-License-Identifier: Apache-2.0
// Thin cli-progress wrapper. Auto-no-ops in non-TTY (CI) and NO_COLOR contexts.
// Used by §04+ for ingest/embed progress bars.
import cliProgress from "cli-progress";

export interface ProgressBar {
  update(current: number, total: number): void;
  finish(): void;
}

export interface ProgressOptions {
  label: string;
  /** Force-enable even in non-TTY (default: only in TTY). */
  force?: boolean;
}

class NoopBar implements ProgressBar {
  update(_current: number, _total: number): void {}
  finish(): void {}
}

class TtyBar implements ProgressBar {
  private bar: cliProgress.SingleBar;
  private started = false;

  constructor(label: string) {
    this.bar = new cliProgress.SingleBar(
      {
        format: `${label} | {bar} | {value}/{total}`,
        clearOnComplete: false,
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );
  }

  update(current: number, total: number): void {
    if (!this.started) {
      this.bar.start(total, current);
      this.started = true;
      return;
    }
    this.bar.setTotal(total);
    this.bar.update(current);
  }

  finish(): void {
    if (this.started) {
      this.bar.stop();
    }
  }
}

/**
 * Returns a TTY progress bar in interactive contexts; a no-op bar otherwise.
 * Friend's CI logs and NO_COLOR users get clean line-based output instead.
 */
export function createProgressBar(opts: ProgressOptions): ProgressBar {
  const isTTY = Boolean(process.stdout.isTTY);
  const noColor = Boolean(process.env.NO_COLOR);
  if (!opts.force && (!isTTY || noColor)) {
    return new NoopBar();
  }
  return new TtyBar(opts.label);
}
