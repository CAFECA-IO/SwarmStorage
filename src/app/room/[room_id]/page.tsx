'use client';

import { useParams, useSearchParams, useRouter } from 'next/navigation';
import RoomFileList from '@/components/room_file_list';

export default function RoomPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Need to handle untyped params from Next.js 15+ (Promise based in server components, but this is client component)
  // In client components, useParams returns the params directly.
  const roomId = params?.room_id as string;
  const initialPassword = searchParams.get('pwd') || undefined;

  // Hydration check not needed for basic params access in client component usually,
  // or use a safe pattern if issues arise. To fix lint, we'll skip it for now.
  // const [mounted, setMounted] = useState(false);
  // useEffect(() => { setMounted(true); }, []);
  // if (!mounted) return null;

  if (!roomId) {
    return <div className="p-8 text-center text-slate-500">Invalid Room ID</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20 pt-8 px-4">
      <div className="max-w-2xl mx-auto">
        <RoomFileList
          roomId={roomId}
          initialPassword={initialPassword}
          onExit={() => router.push('/')}
        />
      </div>
    </div>
  );
}
