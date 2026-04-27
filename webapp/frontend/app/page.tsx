import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-5xl font-semibold tracking-tight">Strix</h1>
      <p className="mt-4 text-lg text-neutral-400">
        AI hackers that find and validate real vulnerabilities in your apps.
      </p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/login"
          className="rounded-md bg-white px-5 py-2.5 text-sm font-medium text-neutral-950 hover:bg-neutral-200"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="rounded-md border border-neutral-700 px-5 py-2.5 text-sm font-medium hover:border-neutral-500"
        >
          Create account
        </Link>
      </div>
    </main>
  );
}
