import { useEffect, useState } from 'react';
import { listProducts } from '../db/seed';
import {
  addProductToActiveList,
  archiveActiveShoppingList,
  buildShoppingListText,
  clearActiveShoppingList,
  getActiveShoppingListWithItems,
  removeShoppingListItem,
  updateShoppingListItemQuantity,
  type ShoppingListRow
} from '../features/shopping-list/shoppingListService';
import { copyTextWithFallback } from '../features/shopping-list/clipboard';
import { type Product } from '../types/domain';

export function ShoppingListPage() {
  const [rows, setRows] = useState<ShoppingListRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [copyFallbackText, setCopyFallbackText] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const [activeList, storedProducts] = await Promise.all([
          getActiveShoppingListWithItems(),
          listProducts()
        ]);
        if (!ignore) {
          setRows(activeList.rows);
          setQuantityDrafts(toQuantityDrafts(activeList.rows));
          setProducts(storedProducts);
          setStatus('ready');
        }
      } catch {
        if (!ignore) {
          setStatus('error');
        }
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, []);

  async function refreshList() {
    const activeList = await getActiveShoppingListWithItems();
    setRows(activeList.rows);
    setQuantityDrafts(toQuantityDrafts(activeList.rows));
    setStatus('ready');
  }

  async function handleAddProduct(product: Product) {
    await addProductToActiveList(product.id);
    setMessage(`${product.name} ajouté à la liste active.`);
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleQuantityCommit(row: ShoppingListRow) {
    const draftValue = quantityDrafts[row.item.id] ?? String(row.item.wantedQuantity);
    const wantedQuantity = Number(draftValue);

    if (!Number.isFinite(wantedQuantity) || wantedQuantity < 1) {
      setQuantityDrafts((current) => ({
        ...current,
        [row.item.id]: String(row.item.wantedQuantity)
      }));
      setMessage('Quantite inchangee.');
      return;
    }

    await updateShoppingListItemQuantity(row.item.id, wantedQuantity);
    setMessage('Quantité mise à jour.');
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleRemove(row: ShoppingListRow) {
    await removeShoppingListItem(row.item.id);
    setMessage(`${row.product.name} retiré de la liste.`);
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleClearConfirmed() {
    await clearActiveShoppingList();
    setMessage('Liste vidée.');
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleArchive() {
    await archiveActiveShoppingList();
    setMessage('Liste archivée. Une nouvelle liste active sera créée au prochain ajout.');
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleCopy() {
    const text = buildShoppingListText(rows);
    const result = await copyTextWithFallback(text);
    if (result === 'copied') {
      setCopyFallbackText('');
      setMessage('Liste copiée en texte.');
    } else {
      setCopyFallbackText(text);
      setMessage('Copie automatique indisponible. Texte affiché ci-dessous.');
    }
  }

  return (
    <section className="pageStack" aria-labelledby="list-title">
      <div>
        <p className="eyebrow">Liste</p>
        <h2 id="list-title">Liste de courses active</h2>
        <p className="lead">
          Ajoute tes produits récurrents, ajuste les quantités, puis copie la liste en texte.
        </p>
      </div>

      {message && <p className="panelText">{message}</p>}
      {copyFallbackText && <pre className="copyFallbackText">{copyFallbackText}</pre>}
      {status === 'loading' && <p className="panelText">Chargement de la liste locale...</p>}
      {status === 'error' && (
        <p className="panelText panelTextDanger">Impossible de charger la liste locale.</p>
      )}

      {status === 'ready' && (
        <>
          <div className="settingsPanel">
            <div>
              <h3>Articles de la liste</h3>
              <p>{rows.length === 0 ? 'Aucun article pour le moment.' : `${rows.length} article(s).`}</p>
            </div>

            <div className="shoppingRows">
              {rows.map((row) => (
                <article className="shoppingRow" key={row.item.id}>
                  <div>
                    <h4>{row.product.name}</h4>
                    <p>{row.product.brand ?? 'Marque non renseignée'}</p>
                  </div>
                  <label>
                    <span>Quantité</span>
                    <input
                      id={`shopping-quantity-${row.item.id}`}
                      name="wantedQuantity"
                      min="1"
                      inputMode="numeric"
                      type="number"
                      value={quantityDrafts[row.item.id] ?? String(row.item.wantedQuantity)}
                      onBlur={() => void handleQuantityCommit(row)}
                      onChange={(event) =>
                        setQuantityDrafts((current) => ({
                          ...current,
                          [row.item.id]: event.target.value
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                  <button className="dangerButton" type="button" onClick={() => void handleRemove(row)}>
                    Retirer
                  </button>
                </article>
              ))}
            </div>

            <div className="cardActions">
              <button className="secondaryButton" type="button" onClick={() => void handleCopy()}>
                Copier la liste
              </button>
              <button
                className="secondaryButton"
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={rows.length === 0}
              >
                Vider la liste
              </button>
              <button className="secondaryButton" type="button" onClick={() => void handleArchive()}>
                Archiver
              </button>
            </div>

            {confirmClear && (
              <div className="confirmPanel">
                <p>Confirmer le vidage de la liste active ?</p>
                <button className="dangerButton" type="button" onClick={() => void handleClearConfirmed()}>
                  Confirmer
                </button>
                <button
                  className="secondaryButton"
                  type="button"
                  onClick={() => setConfirmClear(false)}
                >
                  Annuler
                </button>
              </div>
            )}
          </div>

          <div className="settingsPanel">
            <div>
              <h3>Produits récurrents</h3>
              <p>Ajoute rapidement un produit mémorisé à la liste active.</p>
            </div>
            <div className="quickAddGrid">
              {products.map((product) => (
                <button
                  className="secondaryButton quickAddButton"
                  key={product.id}
                  type="button"
                  onClick={() => void handleAddProduct(product)}
                >
                  {product.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function toQuantityDrafts(rows: ShoppingListRow[]) {
  return Object.fromEntries(rows.map((row) => [row.item.id, String(row.item.wantedQuantity)]));
}
