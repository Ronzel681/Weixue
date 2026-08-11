import { useEffect, useState } from 'react';
import useStore from '../stores/gradingStore';

const STATUS_META = {
  not_started: { label: '未发言', cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-300' },
  recording: { label: '正在发言', cls: 'bg-red-100 text-red-600', dot: 'bg-red-500 animate-pulse' },
  submitted: { label: '已发言', cls: 'bg-blue-100 text-blue-600', dot: 'bg-blue-500' },
  processing: { label: '处理中', cls: 'bg-amber-100 text-amber-600', dot: 'bg-amber-500 animate-pulse' },
  processed: { label: '已处理', cls: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
};

const RATING_META = {
  good: { label: '👍 表达完整', cls: 'bg-green-600 text-white hover:bg-green-700' },
  guide: { label: '➕ 需引导', cls: 'bg-amber-500 text-white hover:bg-amber-600' },
  echo: { label: '⚠️ 复述/未表达', cls: 'bg-red-500 text-white hover:bg-red-600' },
};

const TIER_LABEL = { basic: '低', developing: '中', advancing: '高' };

export default function LiveCockpit() {
  const store = useStore();
  const {
    course, students, topics, responses, liveTopicId,
    liveStatus, liveSuggestions, liveDialogue, liveAdopted, liveBusy,
    liveTranscripts, liveAiQuestions, liveFinished, liveEchoRisk,
    liveMode, livePaused, livePendingSuggestions,
  } = store;
  const [noteDrafts, setNoteDrafts] = useState({});
  const [askDrafts, setAskDrafts] = useState({});
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    if (course?.id) store.subscribeLiveStatus(course.id);
  }, [course?.id]);

  const topic = topics.find(t => t.id === liveTopicId) || topics[0] || null;

  const respFor = (studentId) => {
    const list = responses[studentId] || [];
    return list.find(r => r.topic_id === topic?.id) || null;
  };

  const statusOf = (studentId) => {
    const r = respFor(studentId);
    if (!r) return 'not_started';
    // liveStatus only tracks the current live session. A response that exists
    // but was never touched this session is HISTORY → the card stays 未发言.
    if (liveStatus[r.id]) return liveStatus[r.id];
    // 刷新/回访时 liveStatus 为空：按持久化状态回推，保证历史作答仍可查看与评价。
    if (r.teacher_reviewed) return 'processed';
    if (r.processing_status === 'processed' || r.ai_dimension_scores) return 'processed';
    if (r.processing_status === 'submitted' || r.raw_text) return 'submitted';
    return 'not_started';
  };

  const studentTurnCount = (rid) =>
    (liveDialogue[rid] || []).filter(t => t.role === 'student').length;

  // 需要老师出手的信号（按优先级排序展示）
  const studentSignals = (student) => {
    const resp = respFor(student.id);
    const status = statusOf(student.id);
    const signals = [];
    if (resp && (liveFinished[resp.id] || resp.dialogue_finished) && status !== 'processed') {
      signals.push({ key: 'pending', label: '待评估', cls: 'bg-red-100 text-red-700', score: 0 });
    }
    if (resp && liveEchoRisk[resp.id] && status !== 'processed') {
      signals.push({ key: 'echo', label: '复述风险', cls: 'bg-red-100 text-red-600', score: 1 });
    }
    if (resp && studentTurnCount(resp.id) >= 3 && status !== 'processed') {
      signals.push({ key: 'max3', label: '3轮已满', cls: 'bg-yellow-100 text-yellow-700', score: 2 });
    }
    if (status === 'processing') {
      signals.push({ key: 'processing', label: '处理中', cls: 'bg-amber-100 text-amber-600', score: 3 });
    }
    return signals;
  };

  const studentPriority = (student) => {
    const sig = studentSignals(student);
    if (sig.length > 0) return Math.min(...sig.map(s => s.score));
    const status = statusOf(student.id);
    if (status === 'recording') return 4;
    if (status === 'submitted') return 5;
    return 6;
  };

  const spokenCount = students.filter(s => statusOf(s.id) !== 'not_started').length;
  const reviewedCount = students.filter(s => {
    const r = respFor(s.id);
    return r?.teacher_reviewed;
  }).length;

  const handleAdopt = async (resp, question) => {
    await store.adoptSuggestion(resp.id, question);
  };

  const handleAssess = async (resp) => {
    await store.assessLive(resp.id);
  };

  const handleReview = async (resp, rating) => {
    await store.reviewLive(resp.id, { rating, note: noteDrafts[resp.id] || '' });
  };

  const openStudent = (studentId) => store.openStudentWindow(studentId);

  const renderTeacherAsk = (resp) => {
    const adoptedQ = liveAdopted[resp.id];
    const finished = liveFinished[resp.id] || resp.dialogue_finished || null;
    const turns = studentTurnCount(resp.id);
    const atLimit = turns >= 3;
    return (
      <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
        <div className="text-xs font-semibold text-indigo-700 mb-1.5">老师可随时追问</div>
        {adoptedQ ? (
          <div className="text-xs text-green-700 bg-white rounded-lg p-2 border border-green-200">
            已发问：{adoptedQ}
          </div>
        ) : (
          <div className="flex gap-1.5">
            <input
              value={askDrafts[resp.id] || ''}
              onChange={e => setAskDrafts(prev => ({ ...prev, [resp.id]: e.target.value }))}
              placeholder="给这个学生发一句话…"
              className="flex-1 min-w-0 text-xs border border-indigo-200 rounded-lg px-2 py-1.5 outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
            />
            <button
              onClick={() => {
                const q = (askDrafts[resp.id] || '').trim();
                if (!q) return;
                handleAdopt(resp, q);
                setAskDrafts(prev => ({ ...prev, [resp.id]: '' }));
              }}
              disabled={liveBusy[resp.id]}
              className="shrink-0 text-[11px] font-medium bg-indigo-600 text-white rounded-md px-2.5 py-1.5 hover:bg-indigo-700 disabled:opacity-40"
            >
              发问
            </button>
          </div>
        )}
        <div className="mt-2 flex gap-2">
          {!finished && (
            <button
              onClick={() => store.finishLiveDialogue(resp.id, 'teacher')}
              disabled={liveBusy[resp.id]}
              className="flex-1 text-[11px] font-medium text-indigo-600 border border-indigo-300 rounded-md py-1.5 hover:bg-indigo-100 disabled:opacity-40"
            >
              ⏹ 结束对话
            </button>
          )}
          <button
            onClick={() => handleAssess(resp)}
            disabled={liveBusy[resp.id]}
            className="flex-1 text-[11px] font-medium bg-indigo-600 text-white rounded-md py-1.5 hover:bg-indigo-700 disabled:opacity-40"
          >
            {atLimit ? '已达 3 轮，直接评估' : '直接评估'}
          </button>
        </div>
      </div>
    );
  };

  const renderResult = (resp) => {
    const scores = resp.teacher_dimension_scores || resp.ai_dimension_scores || {};
    const isReviewed = resp.teacher_reviewed;
    const rating = resp.teacher_rating;
    const ratingMeta = RATING_META[rating];
    const dims = Object.entries(scores).slice(0, 5);
    return (
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
        {isReviewed ? (
          <div className="flex items-center gap-2">
            {ratingMeta ? (
              <span className={`text-xs font-bold rounded-full px-2.5 py-1 ${ratingMeta.cls}`}>{ratingMeta.label}</span>
            ) : (
              <span className="text-xs font-bold rounded-full px-2.5 py-1 bg-indigo-600 text-white">已确认</span>
            )}
            {resp.teacher_note && <span className="text-xs text-slate-500 truncate">{resp.teacher_note}</span>}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1 mb-2">
              {dims.map(([dim, r]) => (
                <span key={dim} className="text-[10px] bg-slate-100 text-slate-600 rounded px-1.5 py-0.5">
                  {dim} · {r}
                </span>
              ))}
            </div>
            <div className="flex gap-1.5">
              {Object.entries(RATING_META).map(([key, meta]) => (
                <button
                  key={key}
                  onClick={() => handleReview(resp, key)}
                  disabled={liveBusy[resp.id]}
                  className={`flex-1 text-[11px] font-bold rounded-lg py-2 disabled:opacity-40 ${meta.cls}`}
                >
                  {meta.label}
                </button>
              ))}
            </div>
            <textarea
              value={noteDrafts[resp.id] || ''}
              onChange={e => setNoteDrafts(prev => ({ ...prev, [resp.id]: e.target.value }))}
              rows={1}
              placeholder="轻批注（可选）"
              className="mt-2 w-full text-[11px] border border-slate-200 rounded-lg p-1.5 outline-none focus:ring-1 focus:ring-indigo-300"
            />
            <div className="mt-1.5">
              <button
                onClick={() => setExpanded(prev => ({ ...prev, [resp.id]: !prev[resp.id] }))}
                className="text-[10px] text-indigo-500 underline"
              >
                {expanded[resp.id] ? '收起维度详情' : '展开维度详情'}
              </button>
              {expanded[resp.id] && (
                <div className="mt-1.5 text-[10px] text-slate-500 space-y-1">
                  {dims.map(([dim, r]) => (
                    <div key={dim}>{dim}：{r} — {resp.ai_reasoning?.[dim]?.reasoning || '（无推理说明）'}</div>
                  ))}
                  {resp.cleaned_text && <div>清洗稿：{resp.cleaned_text.slice(0, 80)}…</div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderCard = (student) => {
    const resp = respFor(student.id);
    const status = statusOf(student.id);
    const meta = STATUS_META[status] || STATUS_META.not_started;
    const tier = TIER_LABEL[student.cognitive_tier] || '';
    const isHistory = !!resp && !liveStatus[resp.id];
    const signals = studentSignals(student);
    return (
      <div key={student.id} className={`rounded-2xl border bg-white p-4 shadow-sm ${status === 'recording' ? 'border-red-300' : 'border-slate-200'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${meta.dot}`} />
            <span className="font-semibold text-slate-800">{student.name}</span>
            {tier && <span className="text-[10px] bg-indigo-50 text-indigo-600 rounded px-1.5 py-0.5">{tier}年级段</span>}
          </div>
          <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${meta.cls}`}>{meta.label}</span>
        </div>

        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
          <span>
            {liveStatus[resp?.id]
              ? `${studentTurnCount(resp.id) || 1} 轮`
              : status === 'processed'
                ? '已完成'
                : resp
                  ? '已有作答'
                  : '等待学生发言'}
          </span>
          <button
            onClick={() => openStudent(student.id)}
            className="text-indigo-500 border border-indigo-200 rounded-md px-2 py-0.5 hover:bg-indigo-50"
          >
            打开学生窗口
          </button>
        </div>

        {signals.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {signals.map(s => (
              <span key={s.key} className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${s.cls}`}>{s.label}</span>
            ))}
          </div>
        )}

        {resp && (liveFinished[resp.id] || resp.dialogue_finished) === 'student' && status !== 'processed' && (
          <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-2 text-[11px] text-amber-700">
            ✅ 学生已结束对话，请评估
          </div>
        )}
        {resp && (liveFinished[resp.id] || resp.dialogue_finished) === 'teacher' && status !== 'processed' && (
          <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 p-2 text-[11px] text-slate-500">
            ⏹ 已结束对话，待评估
          </div>
        )}

        {resp && liveTranscripts[resp.id] && status !== 'processed' && (
          <div className="mt-2 rounded-lg bg-red-50 border border-red-100 p-2">
            <div className="text-[10px] text-red-400 mb-0.5">
              {status === 'recording' ? '正在说：' : '已说：'}
            </div>
            <div className="text-[11px] text-red-700 leading-relaxed line-clamp-3">{liveTranscripts[resp.id]}</div>
          </div>
        )}
        {resp && liveAiQuestions[resp.id] && !(liveFinished[resp.id] || resp.dialogue_finished) && (
          <div className="mt-2 rounded-lg bg-indigo-50 border border-indigo-100 p-2">
            <div className="text-[10px] text-indigo-400 mb-0.5">🤖 AI 已追问：</div>
            <div className="text-[11px] text-indigo-700 leading-relaxed">{liveAiQuestions[resp.id]}</div>
          </div>
        )}

        {resp && status === 'submitted' && renderTeacherAsk(resp)}
        {resp && (status === 'processed') && renderResult(resp)}
        {resp && status === 'processing' && (
          <div className="mt-3 text-center text-xs text-amber-500">⏳ AI 评估处理中…</div>
        )}
        {isHistory && status !== 'processed' && (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-2.5">
            <button
              onClick={() => setExpanded(prev => ({ ...prev, [`h${resp.id}`]: !prev[`h${resp.id}`] }))}
              className="text-[10px] text-slate-400 underline"
            >
              {resp.teacher_reviewed ? '历史已处理' : '历史作答'} · 查看历史评估
            </button>
            {expanded[`h${resp.id}`] && (
              <div className="mt-1.5 text-[10px] text-slate-500 space-y-0.5">
                {Object.entries(resp.teacher_dimension_scores || resp.ai_dimension_scores || {}).map(([dim, r]) => (
                  <div key={dim}>{dim} · {r}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!course || students.length === 0) {
    return (
      <div className="text-center text-slate-400 py-16">
        暂无班级数据，请先在「工作台 → 管理」中创建班级和学生。
      </div>
    );
  }

  const finishedCount = students.filter(s => {
    const r = respFor(s.id);
    return r && (liveFinished[r.id] || r.dialogue_finished);
  }).length;
  const pendingCount = students.filter(s => studentSignals(s).some(x => x.key === 'pending')).length;
  const sortedStudents = [...students].sort((a, b) => studentPriority(a) - studentPriority(b));
  const topicIdx = topics.findIndex(t => t.id === topic?.id);
  const pendingList = Object.entries(livePendingSuggestions || {}).flatMap(([rid, sug]) =>
    (sug?.questions || []).map(q => {
      const st = students.find(s => respFor(s.id)?.id === Number(rid));
      return { rid: Number(rid), studentName: st?.name || `#${rid}`, q };
    }),
  );

  return (
    <div className="flex flex-col xl:flex-row gap-4 items-start">
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-bold text-slate-800">{course?.class_name} · {course?.title}</div>
            <div className="text-xs text-slate-400 mt-0.5">课堂模式 · 直播间专用（实时状态来自学生端）</div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[11px] text-slate-500 whitespace-nowrap">
              {topicIdx >= 0 ? `环节 ${topicIdx + 1}/${topics.length}` : ''}
            </span>
            <select
              value={topic?.id || ''}
              onChange={e => store.setLiveTopic(parseInt(e.target.value, 10))}
              className="border border-slate-200 rounded-lg px-2 py-1.5 outline-none"
            >
              {topics.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button
              onClick={store.advanceLiveTopic}
              disabled={topicIdx >= topics.length - 1}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-default cursor-pointer"
            >
              下一环节 →
            </button>
            <span className="bg-blue-50 text-blue-600 rounded-full px-2.5 py-1 font-medium">发言 {spokenCount}/{students.length}</span>
            <span className="bg-purple-50 text-purple-600 rounded-full px-2.5 py-1 font-medium">已结束 {finishedCount}/{students.length}</span>
            <span className="bg-green-50 text-green-700 rounded-full px-2.5 py-1 font-medium">已确认 {reviewedCount}/{students.length}</span>
            {pendingCount > 0 && (
              <span className="bg-red-50 text-red-600 rounded-full px-2.5 py-1 font-medium">待评估 {pendingCount}</span>
            )}
            <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden" title="全班评估进度">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${students.length ? Math.round((reviewedCount / students.length) * 100) : 0}%` }}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {sortedStudents.map(renderCard)}
        </div>
      </div>

      {/* ── AI 伴学控制台 ── */}
      <aside className="w-full xl:w-80 shrink-0 bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-4">
        <div className="text-sm font-semibold text-slate-700">AI 伴学控制台</div>

        <div className="flex items-center gap-2">
          <div className="flex-1 flex rounded-lg border border-slate-200 overflow-hidden">
            <button
              onClick={() => store.setLiveMode('auto')}
              className={`flex-1 text-[11px] py-1.5 font-medium cursor-pointer transition-colors ${liveMode === 'auto' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
            >
              AI 自动
            </button>
            <button
              onClick={() => store.setLiveMode('confirm')}
              className={`flex-1 text-[11px] py-1.5 font-medium cursor-pointer transition-colors ${liveMode === 'confirm' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
            >
              老师确认
            </button>
          </div>
          <button
            onClick={store.togglePause}
            className={`text-[11px] px-3 py-1.5 rounded-lg border font-medium cursor-pointer ${livePaused ? 'bg-green-50 text-green-700 border-green-300' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
          >
            {livePaused ? '▶ 继续' : '⏸ 暂停'}
          </button>
        </div>

        {liveMode === 'confirm' && (
          <div>
            <div className="text-[11px] text-slate-400 mb-1.5">待发送追问</div>
            {pendingList.length === 0 ? (
              <div className="text-[11px] text-slate-300">暂无待发送的追问</div>
            ) : (
              <div className="space-y-2">
                {pendingList.map(({ rid, studentName, q }) => (
                  <div key={`${rid}-${q}`} className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-2">
                    <div className="text-[10px] text-indigo-400">{studentName}</div>
                    <div className="text-[11px] text-slate-700 mt-0.5 leading-relaxed">{q}</div>
                    <div className="flex gap-1.5 mt-1.5">
                      <button
                        onClick={() => store.sendAiSuggestion(rid, q)}
                        className="flex-1 text-[10px] font-medium bg-indigo-600 text-white rounded-md py-1 cursor-pointer"
                      >
                        发送
                      </button>
                      <button
                        onClick={() => store.ignoreSuggestion(rid)}
                        className="flex-1 text-[10px] text-slate-500 border border-slate-200 rounded-md py-1 cursor-pointer"
                      >
                        忽略
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <div className="text-[11px] text-slate-400 mb-1.5">追问时间线</div>
          {sortedStudents.filter(s => respFor(s.id)).length === 0 ? (
            <div className="text-[11px] text-slate-300">还没有对话</div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {sortedStudents.filter(s => respFor(s.id)).map(s => {
                const r = respFor(s.id);
                const turns = liveDialogue[r.id] || [];
                const recent = turns.slice(-3);
                return (
                  <div key={s.id} className="rounded-lg bg-slate-50 border border-slate-100 p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium text-slate-500">{s.name}</span>
                      <button onClick={() => openStudent(s.id)} className="text-[10px] text-indigo-500 cursor-pointer">打开窗口</button>
                    </div>
                    {recent.length === 0 ? (
                      <div className="text-[10px] text-slate-300 mt-1">暂无对话</div>
                    ) : (
                      <div className="mt-1 space-y-1">
                        {recent.map((t, i) => (
                          <div key={i} className="text-[10px] text-slate-600 leading-relaxed">
                            <b className="text-slate-400">{t.role === 'student' ? '生' : t.role === 'teacher' ? '师' : 'AI'}：</b>
                            {t.content}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {pendingCount > 0 && (
          <div>
            <div className="text-[11px] text-slate-400 mb-1.5">待评估</div>
            <div className="space-y-1">
              {sortedStudents.filter(s => studentSignals(s).some(x => x.key === 'pending')).map(s => {
                const r = respFor(s.id);
                return (
                  <div key={s.id} className="flex items-center justify-between text-[11px]">
                    <span className="text-red-600">{s.name}</span>
                    <button
                      onClick={() => r && handleAssess(r)}
                      className="text-[10px] text-red-600 border border-red-200 rounded-md px-2 py-0.5 cursor-pointer"
                    >
                      评估
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
