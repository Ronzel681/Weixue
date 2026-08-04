import { useState, useEffect, useRef } from 'react';
import useStore from '../stores/gradingStore';
import * as api from '../api/client';

const SOURCE_LABEL = { audio: '🎙️ 音频', asr: '📝 妙记', manual: '✍️ 手动' };

export default function RecordingsManager() {
  const { courseId, topics, students, responses, loadCourse } = useStore();
  const [topicId, setTopicId] = useState(null);
  const [studentId, setStudentId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    if (!topicId && topics.length > 0) setTopicId(topics[0].id);
    if (!studentId && students.length > 0) setStudentId(students[0].id);
  }, [topics, students, topicId, studentId]);

  const currentResp = studentId && topicId
    ? (responses[studentId] || []).find(r => r.topic_id === topicId)
    : null;

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !studentId || !topicId) return;
    setUploading(true);
    setMsg('');
    try {
      await api.importAudio(courseId, studentId, topicId, file);
      setMsg('转写完成，已写入作答 ✓');
      await loadCourse(courseId);
    } catch (err) {
      setMsg(`转写失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handlePaste = async () => {
    if (!text.trim() || !studentId || !topicId) return;
    try {
      await api.importText(courseId, studentId, topicId, text.trim());
      setText('');
      setMsg('文本已保存，将进入评估 ✓');
      await loadCourse(courseId);
    } catch (err) {
      setMsg(`保存失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  if (topics.length === 0 || students.length === 0) {
    return (
      <div className="bg-white rounded-xl p-8 border border-slate-200 text-center text-sm text-slate-400">
        请先在「辩题管理」和「学生管理」中录入数据
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-white rounded-xl p-4 border border-slate-200">
        <div className="text-sm font-semibold text-slate-600 mb-3">选择（辩题 × 学生）</div>
        <div className="flex gap-3 flex-wrap">
          <select
            value={topicId || ''}
            onChange={e => setTopicId(parseInt(e.target.value, 10))}
            className="flex-1 min-w-[240px] text-sm border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-300 cursor-pointer"
          >
            {topics.map(t => (
              <option key={t.id} value={t.id}>{t.order}. {t.title}</option>
            ))}
          </select>
          <select
            value={studentId || ''}
            onChange={e => setStudentId(parseInt(e.target.value, 10))}
            className="flex-1 min-w-[200px] text-sm border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-300 cursor-pointer"
          >
            {students.map(st => (
              <option key={st.id} value={st.id}>{st.name}（{st.grade}年级）</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-xl p-4 border border-slate-200">
          <div className="text-sm font-semibold text-slate-600 mb-2">上传录音</div>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.amr,.wma,.flac"
            className="hidden"
            onChange={handleFile}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className={`w-full text-sm py-2.5 rounded-lg font-medium transition-colors cursor-pointer
              ${uploading
                ? 'bg-indigo-50 text-indigo-500 border border-indigo-200'
                : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
          >
            {uploading ? '上传并转写中...' : '🎙️ 选择音频文件'}
          </button>
          <div className="text-[11px] text-slate-400 mt-2">
            支持 mp3 / wav / m4a 等，系统自动转写（当前为演示转写模式）
          </div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200">
          <div className="text-sm font-semibold text-slate-600 mb-2">粘贴转写文本</div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="老师已有转写稿时可直接粘贴..."
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none min-h-[64px] outline-none focus:ring-1 focus:ring-indigo-300"
          />
          <button
            onClick={handlePaste}
            disabled={!text.trim()}
            className="w-full mt-2 text-sm py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-600 font-medium cursor-pointer hover:bg-indigo-100 disabled:opacity-40"
          >
            保存文本
          </button>
        </div>
      </div>

      {msg && <div className="text-xs text-slate-500 bg-white border border-slate-200 rounded-lg px-3 py-2">{msg}</div>}

      <div className="bg-white rounded-xl p-4 border border-slate-200">
        <div className="text-sm font-semibold text-slate-600 mb-2">当前作答</div>
        {currentResp?.raw_text ? (
          <div>
            <div className="text-[11px] text-slate-400 mb-1">
              {SOURCE_LABEL[currentResp.source] || currentResp.source}
              {currentResp.teacher_reviewed ? ' · 已批改' : currentResp.ai_confidence !== 'uncertain' ? ' · AI已评估' : ' · 待评估'}
            </div>
            <div className="text-sm text-slate-700 bg-slate-50 border border-slate-100 rounded-lg p-3 leading-relaxed">
              {currentResp.raw_text}
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-400 py-4 text-center">该学生在本辩题下暂无作答</div>
        )}
      </div>
    </div>
  );
}
