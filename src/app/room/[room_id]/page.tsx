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
    <div className="min-h-screen bg-slate-950 relative flex p-4 font-sans text-slate-100 overflow-x-hidden overflow-y-auto">
      {/* Info: (20260113 - Luphia) Background Grid & Accents */}
      <div className="fixed inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none"></div>
      <div className="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="fixed bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="bg-white/5 backdrop-blur-2xl border border-white/10 rounded-3xl shadow-2xl shadow-black/50 w-full max-w-2xl overflow-hidden p-6 pb-8 relative z-10 m-auto">
        <RoomFileList
          roomId={roomId}
          initialPassword={initialPassword}
          onExit={() => router.push('/')}
        />
      </div>
    </div>
  );
}
