const target = "/frog-progsy/";

export const metadata = {
  title: "FrogProgsy",
};

export default function LegacyContributingRedirect() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <meta httpEquiv="refresh" content={`0; url=${target}`} />
      <h1 className="text-2xl font-semibold">Moving to the docs home</h1>
      <p className="text-fd-muted-foreground">
        The contributing page has been removed from the docs sidebar.
      </p>
      <a className="text-fd-primary underline" href={target}>
        Open the FrogProgsy docs home
      </a>
    </main>
  );
}
