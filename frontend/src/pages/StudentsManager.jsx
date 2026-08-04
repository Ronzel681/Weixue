import { useState } from 'react';
import useStore from '../stores/gradingStore';
import * as api from '../api/client';

const TIER_LABEL = { basic: '基础层', developing: '发展层', advancing: '进阶层' };
const SOURCE_LABEL = { audio: '🎙️', asr: '📝', manual: '✍️' };

const respStatus = (r) => {
  if (r.teacher_reviewed) return { text: '已批改', cls: 'text-indigo-600 bg-indigo-50' };
  if (r.ai_confidence && r.ai_confidence !== 'uncertain') return { text: 'AI已评', cls: 'text-green-600 bg-green-50' };
  return { text: '待评估', cls: 'text-amber-600 bg-amber-50' };
};

// Accepts: 小雨,1年级 / 小雨,1 / 豆豆 2年级 / 豆豆 2
const parseBatchLine = (line) => {
  const cleaned = line.replace(/[年级]+$/, '').trim();
  const m = cleaned.match(/^(.+?)[,，\s]+(\d{1,2})$/);
  return m ? { name: m[1].trim(), grade: parseInt(m[2], 10) } : null;
};

export default function StudentsManager() {
  const { courseId, topics, students, responses, loadCourse } = useStore();
  const [batchText, setBatchText] = useState('');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const [singleName, setSingleName] = useState('');
  const [singleGrade, setSingleGrade] = useState(4);
  const [singleMsg, setSingleMsg] = useState('');

  const topicMap = {};
  topics.forEach(t => { topicMap[t.id] = t; });

  const countByStudent = {};
  Object.entries(responses).forEach(([sid, arr]) => {
    countByStudent[sid] = (arr || []).filter(r => r.raw_text && r.raw_text.trim()).length;
  });

  const addStudents = async (list, done) => {
    try {
      const r = await api.createStudentsBatch(courseId, list);
      const created = r.created?.length ?? 0;
      const skipped = r.skipped?.length ?? 0;
      done(`新增 ${created} 人${skipped ? `，跳过已有 ${skipped} 人` : ''}`);
      await loadCourse(courseId);
    } catch (e) {
      done(`添加失败：${e?.response?.data?.detail || e?.message || '未知错误'}`);
    }
  };

  const handleBatchAdd = async () => {
    const parsed = batchText.split('\n').map(parseBatchLine).filter(Boolean);
    if (parsed.length === 0) {
      setMsg('格式示例（每行一个）：小雨,1年级 或 豆豆 2年级');
      return;
    }
    setAdding(true);
    await addStudents(parsed, m => setMsg(m));
    setAdding(false);
    setBatchText('');
  };

  const handleSingleAdd = async () => {
    if (!singleName.trim()) {
      setSingleMsg('请输入姓名');
      return;
    }
    setAdding(true);
    await addStudents([{ name: singleName.trim(), grade: parseInt(singleGrade, 10) || 4 }], m => setSingleMsg(m));
    setAdding(false);
    setSingleName('');
  };

  const handleDelete = async (st) => {
    if (!window.confirm(`删除学生「${st.name}」？其作答与录音关联也会一并删除。`)) return;
    await api.deleteStudent(st.id);
    await loadCourse(courseId);
  };

  const handleRemoveResponse = async (rid) => {
    if (!window.confirm('移除该学生在本题的作答？')) return;
    await api.deleteResponse(rid);
    await loadCourse(courseId);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 单个添加 */}
      <div className="bg-white rounded-xl p-4 border border-slate-200">
        <div className="text-sm font-semibold text-slate-600 mb-2">添加学生</div>
        <div className="flex gap-2 items-center">
          <input
            value={singleName}
            onChange={e => setSingleName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSingleAdd(); }}
            placeholder="姓名（如：小雨）"
            className="flex-1 max-w-[200px] text-sm border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-300"
          />
          <select
            value={singleGrade}
            onChange={e => setSingleGrade(parseInt(e.target.value, 10))}
            className="text-sm border border-slate-200 rounded-lg px-2 py-2 outline-none cursor-pointer"
          >
            {[1, 2, 3, 4, 5, 6, 7].map(g => <option key={g} value={g}>{g}年级</option>)}
          </select>
          <button
            onClick={handleSingleAdd}
            disabled={adding || !singleName.trim()}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-medium cursor-pointer hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            {adding ? '添加中...' : '＋ 添加'}
          </button>
          {singleMsg && <span className="text-xs text-slate-500">{singleMsg}</span>}
        </div>
      </div>

      {/* 批量添加 */}
      <div className="bg-white rounded-xl p-4 border border-slate-200">
        <div className="text-sm font-semibold text-slate-600 mb-2">批量添加（每行一个：姓名,年级）</div>
        <textarea
          value={batchText}
          onChange={e => setBatchText(e.target.value)}
          placeholder={'小雨,1年级\n豆豆 2年级'}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none min-h-[64px] outline-none focus:ring-1 focus:ring-indigo-300"
        />
        <div className="flex items-center gap-3 mt-2">
          <button
            onClick={handleBatchAdd}
            disabled={adding || !batchText.trim()}
            className="px-4 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-600 text-xs font-medium cursor-pointer hover:bg-indigo-100 disabled:opacity-40 transition-colors"
          >
            {adding ? '添加中...' : '+ 批量添加'}
          </button>
          {msg && <span className="text-xs text-slate-500">{msg}</span>}
        </div>
      </div>

      {/* 学生列表 */}
      <div className="bg-white rounded-xl p-4 border border-slate-200">
        <div className="text-sm font-semibold text-slate-600 mb-3">学生列表（{students.length}）</div>
        <div className="flex flex-col gap-2">
          {students.map(st => {
            const studentResponses = (responses[st.id] || []).filter(r => r.raw_text && r.raw_text.trim());
            return (
              <div key={st.id} className="border border-slate-100 rounded-lg px-3 py-2">
                {editingId === st.id ? (
                  <EditRow
                    student={st}
                    onDone={async () => { setEditingId(null); await loadCourse(courseId); }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-40 shrink-0">
                      <div className="text-sm font-medium text-slate-800">{st.name}</div>
                      <div className="text-[11px] text-slate-400">{TIER_LABEL[st.cognitive_tier] || st.cognitive_tier}</div>
                    </div>
                    <div className="text-sm text-slate-600 w-20">{st.grade}年级</div>
                    <div className="flex-1 text-xs text-slate-400">{countByStudent[st.id] || 0} 份作答</div>
                    <button
                      onClick={() => setExpandedId(expandedId === st.id ? null : st.id)}
                      className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-500 cursor-pointer hover:bg-slate-50"
                    >
                      {expandedId === st.id ? '收起辩题 ▴' : '查看辩题 ▾'}
                    </button>
                    <button
                      onClick={() => setEditingId(st.id)}
                      className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-500 cursor-pointer hover:bg-slate-50"
                    >编辑</button>
                    <button
                      onClick={() => handleDelete(st)}
                      className="text-xs px-2.5 py-1 rounded-md border border-red-200 bg-white text-red-500 cursor-pointer hover:bg-red-50"
                    >删除</button>
                  </div>
                )}
                {expandedId === st.id && (
                  <div className="mt-2 pl-3 border-l-2 border-indigo-100 flex flex-col gap-1.5">
                    {studentResponses.length === 0 && (
                      <div className="text-xs text-slate-400 py-1.5 text-center">暂无作答，请到「录音录入」上传</div>
                    )}
                    {studentResponses.map(r => {
                      const t = topicMap[r.topic_id];
                      const s = respStatus(r);
                      return (
                        <div key={r.id} className="flex items-center gap-2 text-xs bg-slate-50 rounded-md px-2.5 py-1.5">
                          <span className="flex-1 min-w-0 truncate">{t ? `${t.order}. ${t.title}` : `辩题#${r.topic_id}`}</span>
                          <span className={`px-1.5 py-0.5 rounded ${s.cls}`}>{s.text}</span>
                          <span className="text-slate-400">{SOURCE_LABEL[r.source] || r.source}</span>
                          <button
                            onClick={() => handleRemoveResponse(r.id)}
                            className="text-red-400 hover:text-red-600 cursor-pointer"
                          >移除</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {students.length === 0 && (
            <div className="text-xs text-slate-400 py-6 text-center">暂无学生，请使用上方表单添加</div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditRow({ student, onDone, onCancel }) {
  const [name, setName] = useState(student.name);
  const [grade, setGrade] = useState(student.grade);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await api.updateStudent(student.id, { name: name.trim(), grade: parseInt(grade, 10) || student.grade });
    setSaving(false);
    await onDone();
  };

  return (
    <div className="flex items-center gap-2">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        className="w-40 text-sm border border-slate-200 rounded-lg px-2 py-1 outline-none"
      />
      <select value={grade} onChange={e => setGrade(parseInt(e.target.value, 10))} className="text-sm border border-slate-200 rounded-lg px-2 py-1 outline-none cursor-pointer">
        {[1, 2, 3, 4, 5, 6, 7].map(g => <option key={g} value={g}>{g}年级</option>)}
      </select>
      <button
        onClick={handleSave}
        disabled={saving || !name.trim()}
        className="text-xs px-2.5 py-1 rounded-md bg-indigo-600 text-white cursor-pointer hover:bg-indigo-700 disabled:opacity-40"
      >
        {saving ? '保存中...' : '保存'}
      </button>
      <button onClick={onCancel} className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-500 cursor-pointer">
        取消
      </button>
    </div>
  );
}
