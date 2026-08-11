import { useEffect, useMemo, useState } from 'react';
import useStore from '../stores/gradingStore';
import { computeClassReport } from '../utils/analytics';
import { ratingToNumber } from '../utils/ratings';
import * as api from '../api/client';

const DIM_LABELS = {
  clarity: '清晰性', interpretation: '解释力', evidence_awareness: '证据意识',
  relevance: '相关性', inference: '因果推理', evidence_use: '证据使用',
  argument_evaluation: '论证质量', depth_breadth: '深度广度', self_regulation: '反思调节',
};

const barColor = (val) => {
  if (val >= 3.5) return 'bg-green-500';
  if (val >= 3) return 'bg-emerald-400';
  if (val >= 2.5) return 'bg-yellow-400';
  if (val > 0) return 'bg-orange-400';
  return 'bg-red-500';
};

const scoreLabel = (avg) => {
  if (avg >= 3.5) return { text: '优秀', cls: 'text-green-600' };
  if (avg >= 2.5) return { text: '良好', cls: 'text-emerald-600' };
  if (avg >= 1.5) return { text: '待提升', cls: 'text-yellow-600' };
  if (avg > 0) return { text: '薄弱', cls: 'text-red-600' };
  return { text: '未评', cls: 'text-slate-400' };
};

const ratingColor = (v) => {
  if (v >= 3.5) return '#16a34a';
  if (v >= 2.5) return '#10b981';
  if (v >= 1.5) return '#eab308';
  return v > 0 ? '#f97316' : '#94a3b8';
};

/** Pure-SVG radar chart for up to 9 dimension averages (0-4 scale). */
function RadarChart({ data, labels }) {
  const keys = Object.keys(data || {});
  if (keys.length < 3) {
    return <div className="text-xs text-slate-400 py-8 text-center">维度数据不足（至少 3 个维度）</div>;
  }
  const size = 340;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 52;
  const angle = (i) => (Math.PI * 2 * i) / keys.length - Math.PI / 2;
  const ring = (frac) =>
    keys.map((_, i) => `${cx + r * Math.cos(angle(i)) * frac},${cy + r * Math.sin(angle(i)) * frac}`).join(' ');
  const polygon = keys
    .map((k, i) => {
      const v = Math.min(Math.max(data[k] || 0, 0), 4);
      return `${cx + r * Math.cos(angle(i)) * (v / 4)},${cy + r * Math.sin(angle(i)) * (v / 4)}`;
    })
    .join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${size} ${size}`} className="max-w-[360px] mx-auto block">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="#e2e8f0" strokeWidth={1} />
      ))}
      {keys.map((k, i) => {
        const x1 = cx + r * Math.cos(angle(i));
        const y1 = cy + r * Math.sin(angle(i));
        const lx = cx + (r + 36) * Math.cos(angle(i));
        const ly = cy + (r + 36) * Math.sin(angle(i));
        const mx = cx + (r / 2) * Math.cos(angle(i));
        const my = cy + (r / 2) * Math.sin(angle(i));
        const v = Math.min(Math.max(data[k] || 0, 0), 4);
        return (
          <g key={k}>
            <line x1={cx} y1={cy} x2={x1} y2={y1} stroke="#e2e8f0" strokeWidth={1} />
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#64748b">
              {labels[k] || k}
            </text>
            <text x={mx} y={my - 5} textAnchor="middle" fontSize={10} fill={ratingColor(v)}>
              {v.toFixed(1)}
            </text>
          </g>
        );
      })}
      <polygon points={polygon} fill="rgba(99,102,241,0.22)" stroke="#6366f1" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}

function ParentReportView({ report, loading, onBack }) {
  if (loading) {
    return <div className="text-slate-400 py-16 text-center">正在生成家长报告...</div>;
  }
  if (!report || report.error) {
    return (
      <div className="bg-white rounded-xl p-8 border border-slate-200 text-center">
        <div className="text-red-500 mb-3">报告加载失败</div>
        <button onClick={onBack} className="text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer">返回班级报告</button>
      </div>
    );
  }
  if (!report.has_report) {
    return (
      <div className="bg-white rounded-xl p-8 border border-slate-200 text-center">
        <div className="text-lg font-semibold text-slate-700 mb-2">{report.name} 的学情报告</div>
        <div className="text-slate-400 text-sm mb-4">该学生暂未完成评估，暂无报告内容</div>
        <button onClick={onBack} className="text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer">返回班级报告</button>
      </div>
    );
  }

  const dims = Object.entries(report.dimensions || {});
  return (
    <div className="flex flex-col gap-5">
      <div className="bg-white rounded-xl p-5 border border-slate-200 flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-slate-800">{report.name} 的学情报告</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {report.grade}年级 · {report.topic_title || '思辨课堂'}
            {report.reviewed ? ' · 已由教师确认' : ' · 待教师确认'}
          </div>
        </div>
        <button
          onClick={onBack}
          className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer"
        >
          ← 返回班级报告
        </button>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="bg-white rounded-xl p-5 border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">思辨能力画像</h3>
          {dims.length === 0 ? (
            <div className="text-xs text-slate-400">暂无维度评分</div>
          ) : (
            <div className="space-y-2.5">
              {dims.map(([label, rating]) => {
                const v = ratingToNumber(rating);
                return (
                  <div key={label} className="flex items-center gap-3">
                    <div className="w-24 text-xs text-slate-600 shrink-0">{label}</div>
                    <div className="flex-1 bg-slate-100 rounded h-3.5 overflow-hidden">
                      <div
                        className="h-full rounded transition-all"
                        style={{ width: `${v !== null ? Math.max((v / 4) * 100, 3) : 0}%`, backgroundColor: ratingColor(v ?? 0) }}
                      />
                    </div>
                    <div className="w-10 text-xs text-right font-semibold text-slate-600">{rating}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="bg-white rounded-xl p-5 border border-slate-200">
            <h3 className="text-sm font-semibold text-slate-800 mb-2">教师评语</h3>
            <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
              {report.teacher_comment || '暂未填写评语。'}
            </p>
          </div>
          <div className="bg-white rounded-xl p-5 border border-slate-200">
            <h3 className="text-sm font-semibold text-slate-800 mb-2">综合评价</h3>
            <div className="text-lg font-bold" style={{ color: ratingColor(report.rating ? ratingToNumber(report.rating) : 0) }}>
              {report.rating || '待评定'}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl p-5 border border-slate-200">
        <h3 className="text-sm font-semibold text-slate-800 mb-3">给家长的建议</h3>
        <ul className="list-disc pl-5 space-y-1.5">
          {(report.next_steps || []).map((step, i) => (
            <li key={i} className="text-sm text-slate-600">{step}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function ReportPage() {
  const { courseId, students, topics, responses, tags } = useStore();
  const [parentSid, setParentSid] = useState(null);
  const [parentReport, setParentReport] = useState(null);
  const [parentLoading, setParentLoading] = useState(false);

  const report = useMemo(
    () => computeClassReport(
      students,
      topics,
      Object.values(responses).flat(),
      tags,
      courseId,
    ),
    [students, topics, responses, tags, courseId],
  );

  const classDimScores = useMemo(() => {
    const dims = {};
    const studentIds = new Set(students.map((s) => s.id));
    Object.values(responses)
      .flat()
      .filter((r) => r.student_id !== undefined && studentIds.has(r.student_id))
      .forEach((r) => {
        const scores = r.teacher_dimension_scores || r.ai_dimension_scores;
        const confidence = r.teacher_confidence_override || r.ai_confidence;
        if (confidence === 'uncertain' && !r.teacher_dimension_scores) return;
        if (!scores || typeof scores !== 'object') return;
        Object.entries(scores).forEach(([dim, rating]) => {
          const v = ratingToNumber(rating);
          if (v !== null) (dims[dim] ||= []).push(v);
        });
      });
    return Object.fromEntries(
      Object.entries(dims).map(([dim, vals]) => [
        dim,
        Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
      ]),
    );
  }, [students, responses]);

  const openParentReport = async (sid) => {
    setParentSid(sid);
    setParentLoading(true);
    setParentReport(null);
    try {
      setParentReport(await api.getStudentReport(sid));
    } catch {
      setParentReport({ error: true });
    }
    setParentLoading(false);
  };

  if (parentSid) {
    return (
      <ParentReportView
        report={parentReport}
        loading={parentLoading}
        onBack={() => {
          setParentSid(null);
          setParentReport(null);
        }}
      />
    );
  }

  if (!courseId) {
    return <div className="text-slate-400 py-10 text-center">加载报告...</div>;
  }
  if (!report || report.student_count === 0) {
    return <div className="text-red-500 py-10 text-center">报告加载失败：暂无班级数据</div>;
  }

  const classLabel = scoreLabel(report.class_avg);

  return (
    <div className="flex flex-col gap-5">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: '参评人数', value: `${report.student_count}人`, color: 'text-slate-600' },
          { label: '班级均分', value: `${report.class_avg.toFixed(1)}/4.0`, color: classLabel.cls },
          { label: '最高均分', value: report.student_stats.length > 0 ? `${Math.max(...report.student_stats.map(s => s.avg_score)).toFixed(1)}` : '-', color: 'text-green-600' },
          { label: '辩题数', value: report.topic_stats.length, color: 'text-slate-600' },
        ].map((c, i) => (
          <div key={i} className="bg-white rounded-xl p-4 border border-slate-200">
            <div className="text-slate-400 text-xs">{c.label}</div>
            <div className={`text-xl font-bold mt-1 ${c.color}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Class-level radar */}
      <div className="bg-white rounded-xl p-5 border border-slate-200">
        <h3 className="text-sm font-semibold text-slate-800 mb-2">班级思辨能力雷达</h3>
        <div className="text-[11px] text-slate-400 mb-1">基于全班已确认评分的维度均值（0-4 分）</div>
        <RadarChart data={classDimScores} labels={DIM_LABELS} />
      </div>

      {/* Per-topic dimension breakdown */}
      <div className="bg-white rounded-xl p-5 border border-slate-200">
        <h3 className="text-sm font-semibold text-slate-800 mb-4">各辩题维度均分</h3>
        {report.topic_stats.map(ts => (
          <div key={ts.topic_id} className="mb-4 pb-3 border-b border-slate-50 last:border-0 last:pb-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-slate-700">{ts.title}</span>
              <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{ts.cognitive_tier}</span>
              {ts.uncertain > 0 && <span className="text-[10px] text-slate-400">{ts.uncertain}人存疑</span>}
            </div>
            {Object.entries(ts.avg_dimension_scores).length > 0 ? (
              <div className="space-y-1.5">
                {Object.entries(ts.avg_dimension_scores).map(([dim, val]) => (
                  <div key={dim} className="flex items-center gap-3">
                    <div className="w-20 text-xs text-slate-500 shrink-0">{DIM_LABELS[dim] || dim}</div>
                    <div className="flex-1 bg-slate-100 rounded h-4 overflow-hidden">
                      <div className={`h-full rounded transition-all ${barColor(val)}`}
                        style={{ width: `${Math.max((val / 4) * 100, 2)}%` }} />
                    </div>
                    <div className={`w-12 text-xs text-right font-semibold ${barColor(val).replace('bg-', 'text-')}`}>{val.toFixed(1)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400">暂无评估数据</div>
            )}
          </div>
        ))}
      </div>

      {/* Per-student scores */}
      <div className="bg-white rounded-xl p-5 border border-slate-200">
        <h3 className="text-sm font-semibold text-slate-800 mb-3">学生个体评估</h3>
        <div className="grid grid-cols-3 gap-2">
          {report.student_stats.map(s => {
            const sl = scoreLabel(s.avg_score);
            return (
              <div key={s.student_id} className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                <div className="flex justify-between items-center mb-1.5">
                  <div>
                    <span className="text-sm font-medium text-slate-700">{s.name}</span>
                    <span className="text-[10px] text-slate-400 ml-1.5">{s.grade}年级</span>
                  </div>
                  <span className={`text-sm font-bold ${sl.cls}`}>{s.avg_score > 0 ? s.avg_score.toFixed(1) : '-'}</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {s.cognitive_tier === 'basic' ? '基础层' : s.cognitive_tier === 'developing' ? '发展层' : '进阶层'}
                  {s.uncertain > 0 ? ` · ${s.uncertain}题存疑` : ''}
                </div>
                <button
                  onClick={() => openParentReport(s.student_id)}
                  className="mt-2 text-[11px] px-2 py-1 rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 cursor-pointer w-full"
                >
                  查看家长报告
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top tags */}
      {report.top_tags.length > 0 && (
        <div className="bg-white rounded-xl p-5 border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">高频标签</h3>
          {report.top_tags.filter(t => t.count > 0).map((t, i) => (
            <div key={t.name} className="flex items-start gap-2.5 py-2 border-b border-slate-50 last:border-0">
              <span className="bg-red-100 text-red-700 text-[11px] font-semibold px-2 py-0.5 rounded shrink-0">{t.count}次</span>
              <div>
                <div className="text-sm text-slate-800">{t.name}</div>
                <div className="text-[11px] text-slate-400">{t.source === 'ai_new' ? 'AI新增标签' : '基础标签'}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
