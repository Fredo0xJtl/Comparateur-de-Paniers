import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

// Sans filet, une exception levée pendant le rendu d'une page démonte tout
// l'arbre React : l'utilisateur se retrouve devant une page entièrement
// blanche, sans navigation ni message, et sans autre issue que de recharger
// lui-même — en supposant qu'il comprenne ce qui vient de se passer.
//
// Le chargement différé des pages ajoute un second chemin vers ce même écran
// blanc : un chunk qui n'arrive pas (réseau coupé, ancien fichier supprimé par
// un redéploiement pendant que l'onglet était ouvert) rejette dans Suspense,
// ce qu'aucun `fallback` n'intercepte.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console uniquement : aucun rapport d'erreur distant, conformément à la
    // politique de confidentialité du projet.
    console.error('[App] erreur non rattrapée', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleBackHome = () => {
    // Rechargement complet plutôt que navigation React : l'arbre est dans un
    // état inconnu, et l'accueil doit repartir d'une base saine.
    window.location.assign('/');
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const isChunkError = isChunkLoadError(error);

    return (
      <section className="errorBoundary" role="alert">
        <h2>{isChunkError ? 'Cette page n’a pas pu être chargée' : 'Une erreur est survenue'}</h2>
        <p>
          {isChunkError
            ? 'La connexion a été interrompue, ou une nouvelle version de l’application a été publiée pendant que cet onglet était ouvert. Recharger la page suffit généralement.'
            : 'Tes données locales ne sont pas affectées : rien n’a été supprimé, tout est toujours stocké sur cet appareil.'}
        </p>
        <div className="errorBoundaryActions">
          <button className="primaryButton" type="button" onClick={this.handleReload}>
            Recharger la page
          </button>
          <button className="secondaryButton" type="button" onClick={this.handleBackHome}>
            Retour à l’accueil
          </button>
        </div>
        <details>
          <summary>Détail technique</summary>
          <pre>{error.message}</pre>
        </details>
      </section>
    );
  }
}

// Chaque navigateur formule ce cas à sa manière et aucun n'expose de code
// d'erreur exploitable ; le test porte donc sur le message.
export function isChunkLoadError(error: Error): boolean {
  const message = `${error.name} ${error.message}`.toLowerCase();
  return (
    message.includes('dynamically imported module') ||
    message.includes('chunkloaderror') ||
    message.includes('importing a module script failed') ||
    message.includes('error loading dynamically imported module')
  );
}
