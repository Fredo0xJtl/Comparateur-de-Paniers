import { useEffect, useState } from 'react';
import { archiveActiveShoppingList, getLastBasketOfActiveList } from './shoppingListService';

// Au retour dans l'application, la liste de la dernière fois est toujours là :
// sans ce rappel, on relance une comparaison sur des courses déjà faites, avec
// des prix périmés. Les produits, eux, restent dans la page Produits (et dans
// les favoris) : seule la liste repart de zéro.
export function ListAlreadyUsedNotice({ onNewList }: { onNewList: () => void | Promise<void> }) {
  const [preparedAt, setPreparedAt] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    void getLastBasketOfActiveList()
      .then((basket) => {
        if (!ignore) setPreparedAt(basket?.validatedAt ?? null);
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, []);

  if (!preparedAt) return null;

  async function handleNewList() {
    await archiveActiveShoppingList();
    setPreparedAt(null);
    await onNewList();
  }

  return (
    <div className="settingsPanel" role="status">
      <div>
        <h3>Courses déjà faites ?</h3>
        <p>
          Un panier a été préparé avec cette liste le{' '}
          {new Date(preparedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}. Si ces courses
          sont faites, repars d’une liste vide : tes produits restent dans la page Produits et dans tes favoris.
        </p>
      </div>
      <div className="cardActions">
        <button className="primaryButton" type="button" onClick={() => void handleNewList()}>
          Commencer une nouvelle liste
        </button>
      </div>
    </div>
  );
}
