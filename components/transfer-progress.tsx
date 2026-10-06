import { CheckCheck, ExternalLink, LoaderCircle } from "lucide-react";
import { transferJobLabels, type TransferJobSummary } from "@/lib/task-types";

export function TransferProgress({
  job,
  pending,
  retry,
  connect,
}: {
  job: TransferJobSummary;
  pending: boolean;
  retry: () => void;
  connect: () => void;
}) {
  const active = ["queued", "running", "waiting"].includes(job.status);
  return (
    <section
      className={`result-panel transfer-progress ${job.status === "complete" ? "success" : "partial"}`}
      aria-live="polite"
    >
      <span className="result-icon">
        {job.status === "complete" ? (
          <CheckCheck size={28} />
        ) : (
          <LoaderCircle size={28} className={active ? "spin" : ""} />
        )}
      </span>
      <div className="transfer-progress-body">
        <h2>
          {job.verifying && active
            ? "后台正在核实上次写入"
            : transferJobLabels[job.status]}
        </h2>
        <p>
          已确认写入 {job.added} / {job.total} 首歌曲。
        </p>
        <div
          className="task-mini-progress"
          role="progressbar"
          aria-label="Spotify 写入进度"
          aria-valuenow={job.added}
          aria-valuemin={0}
          aria-valuemax={job.total}
        >
          <span
            style={{
              width: `${job.total ? (job.added / job.total) * 100 : 0}%`,
            }}
          />
        </div>
        {active && (
          <p>
            可以关闭网页，服务器会继续处理。回来后在「后台任务」查看进度和结果。
          </p>
        )}
        {job.resumeAt > 0 && (
          <p>预计继续：{new Date(job.resumeAt).toLocaleString("zh-CN")}</p>
        )}
        {job.error && <p>{job.error}</p>}
        {["needs_auth", "failed"].includes(job.status) && (
          <button className="secondary-button" onClick={connect}>
            重新连接 Spotify
          </button>
        )}
        {["failed", "needs_auth", "blocked"].includes(job.status) && (
          <button
            className="secondary-button"
            disabled={pending}
            onClick={retry}
          >
            {job.status === "blocked" || job.verifying
              ? "重新核实 Spotify 结果"
              : "继续后台写入"}
          </button>
        )}
      </div>
      {job.url && (
        <a
          className="primary-button"
          href={job.url}
          target="_blank"
          rel="noreferrer"
        >
          在 Spotify 打开 <ExternalLink size={15} />
        </a>
      )}
    </section>
  );
}
