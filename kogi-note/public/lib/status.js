// 授業の状態を、画面に出す言葉にする

export function statusLabel(lecture) {
  switch (lecture.status) {
    case 'uploading':
      return '音声を入れてね';
    case 'done':
      return '完成';
    case 'error':
      return 'エラー';
    case 'processing':
      if (lecture.waiting_reason === 'rate_limited') return '混んでいるので待っています';
      if (lecture.step === 'wait_file') return '準備中';
      if (lecture.step === 'transcribe') {
        const total = lecture.segments_total;
        if (!total) return '文字起こし中';
        return `文字起こし中（${Math.min((lecture.segments_done ?? 0) + 1, total)}/${total}）`;
      }
      return '要約を作っています';
    default:
      return '';
  }
}

export const isWorking = (lecture) => lecture.status === 'processing';
