'use client';

import { useParams, useSearchParams, useRouter } from 'next/navigation';
import RoomWorkspace from '@/components/room_workspace';

export default function RoomPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Info: (20260113 - Luphia) In client components, useParams returns the params directly.
  const roomId = params?.room_id as string;
  const initialPassword = searchParams.get('pwd') || undefined;
  // Info: (20261105 - Luphia) ?file= 直接開啟指定檔案 (Copy link 產生的連結)
  const initialFile = searchParams.get('file') || undefined;

  if (!roomId) {
    return <div className="p-8 text-center text-slate-500">Invalid Room ID</div>;
  }

  return (
    <RoomWorkspace
      roomId={roomId}
      initialPassword={initialPassword}
      initialFile={initialFile}
      onExit={() => router.push('/')}
    />
  );
}
