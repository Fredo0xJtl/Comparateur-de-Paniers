import { useEffect, useRef } from 'react';
import { buildWelcomeSteps, type WelcomeState } from './onboardingService';

type WelcomeDialogProps = {
  state: WelcomeState;
  onClose: () => void;
};

/**
 * Fenêtre d'accueil : la première chose que voit quelqu'un qui découvre
 * l'application. Elle dit ce qu'il faut installer, dans quel ordre, et où en
 * est chaque étape.
 *
 * Écrite pour être lue par quelqu'un qui n'a jamais entendu parler
 * d'extension de navigateur : pas de vocabulaire technique, une action
 * visible par étape, et aucune étape qu'on ne puisse pas faire depuis là.
 */
export function WelcomeDialog({ state, onClose }: WelcomeDialogProps) {
  const steps = buildWelcomeSteps(state);
  const closeRef = useRef<HTMLButtonElement>(null);
  const remaining = steps.filter((step) => step.id !== 'compte' && !step.done).length;

  useEffect(() => {
    // Le focus entre dans la fenêtre : sans ça, la navigation au clavier et
    // les lecteurs d'écran restent sur la page derrière, qui est masquée.
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="welcomeOverlay" role="presentation" onClick={onClose}>
      <div
        className="welcomeDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        // Un clic à l'intérieur ne doit pas fermer la fenêtre : seul le fond
        // la ferme.
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="welcome-title">Bienvenue — trois choses à faire une seule fois</h2>
        <p className="welcomeIntro">
          Cette application compare vos courses entre Leclerc Drive et Courses U, puis remplit votre panier à votre
          place. Pour lire les prix sur les sites des magasins, elle a besoin d’un petit programme à ajouter à Firefox :
          le connecteur.
        </p>

        <ol className="welcomeSteps">
          {steps.map((step, index) => (
            <li key={step.id} className={step.done ? 'welcomeStep welcomeStepDone' : 'welcomeStep'}>
              <span className="welcomeStepMark" aria-hidden="true">
                {step.done ? '✓' : index + 1}
              </span>
              <div>
                <h3>
                  {step.title}
                  {step.done && <span className="welcomeStepBadge"> — c’est fait</span>}
                </h3>
                <p>{step.description}</p>
                {step.action && (
                  <a
                    className="welcomeStepAction"
                    href={step.action.href}
                    // L'installation se fait sur un autre site : ouvrir dans
                    // un nouvel onglet évite de perdre l'application, et
                    // `noopener` empêche la page ouverte d'agir sur celle-ci.
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {step.action.label}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>

        <p className="welcomeNote">
          Vos listes, vos prix et vos magasins restent sur cet appareil. Rien n’est envoyé sur Internet, il n’y a ni
          compte à créer ni serveur.
        </p>
        {state.support.isMobile && (
          <p className="welcomeNote">
            Astuce : dans le menu de Firefox, « Ajouter à l’écran d’accueil » installe l’application comme les autres,
            avec son icône.
          </p>
        )}

        <div className="welcomeActions">
          <button ref={closeRef} type="button" className="primaryButton" onClick={onClose}>
            {remaining === 0 ? 'Commencer' : 'Fermer'}
          </button>
        </div>
        {remaining > 0 && (
          <p className="welcomeFootnote">
            Une fois le connecteur ajouté, rechargez cette page : l’étape se cochera toute seule.
          </p>
        )}
      </div>
    </div>
  );
}
