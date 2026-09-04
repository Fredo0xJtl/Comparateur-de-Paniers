import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProducts } from '../db/seed';
import { ProductForm } from '../features/products/ProductForm';
import {
  deleteProduct,
  emptyProductForm,
  markProductUsed,
  productToForm,
  toggleProductFavorite,
  updateProduct,
  type ProductFormErrors,
  type ProductFormValues
} from '../features/products/productService';
import { addProductToActiveList } from '../features/shopping-list/shoppingListService';
import { type Product } from '../types/domain';

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editValues, setEditValues] = useState<ProductFormValues>(emptyProductForm);
  const [editErrors, setEditErrors] = useState<ProductFormErrors>({});
  const [message, setMessage] = useState('');

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const storedProducts = await listProducts();
        if (!ignore) {
          setProducts(sortByFavoriteThenName(storedProducts));
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

  async function refreshProducts() {
    setProducts(sortByFavoriteThenName(await listProducts()));
    setStatus('ready');
  }

  async function handleUpdateProduct() {
    if (!editingProduct) {
      return;
    }
    const result = await updateProduct(editingProduct, editValues);
    setEditErrors(result.errors);
    if (!result.isValid) {
      return;
    }
    setEditingProduct(null);
    setMessage('Produit modifié localement.');
    await refreshProducts();
  }

  async function handleDeleteProduct(product: Product) {
    await deleteProduct(product.id);
    setMessage('Produit supprimé localement.');
    await refreshProducts();
  }

  async function handleAddToList(product: Product) {
    await addProductToActiveList(product.id);
    await markProductUsed(product);
    setMessage(`${product.name} ajouté à la liste active.`);
    await refreshProducts();
  }

  async function handleToggleFavorite(product: Product) {
    await toggleProductFavorite(product);
    setMessage(
      product.isFavorite ? `${product.name} retiré des favoris.` : `${product.name} ajouté aux favoris.`
    );
    await refreshProducts();
  }

  return (
    <section className="pageStack" aria-labelledby="products-title">
      <div className="pageTitle">
        <h2 id="products-title">Produits mémorisés</h2>
        {/* Cette page ne crée plus de produit : elle n'affichait qu'un second
            écran d'ajout, concurrent de celui du Scan, avec un formulaire
            complet à remplir de zéro. Tout ajout passe désormais par le Scan,
            qui propose les quatre chemins dans l'ordre où ils servent (nom
            déjà connu, fiche officielle, catalogue du magasin, code-barres) —
            et, en dernier recours, ce même formulaire complet. */}
        <p className="panelText">
          Les produits s'ajoutent depuis la page <Link to="/scan">Scan</Link>. Ici, tu peux les
          corriger, les supprimer ou les remettre dans ta liste.
        </p>
      </div>

      {message && <p className="panelText">{message}</p>}

      {status === 'loading' && <p className="panelText">Chargement des produits locaux...</p>}
      {status === 'error' && (
        <p className="panelText panelTextDanger">Impossible de charger la base locale.</p>
      )}

      {status === 'ready' && products.length === 0 && (
        <div className="settingsPanel">
          <div>
            <h3>Aucun produit mémorisé</h3>
            <p>Ajoute ton premier produit depuis le Scan, ou pioche dans ta liste de courses.</p>
          </div>
          <div className="cardActions">
            <Link className="buttonLink" to="/scan">
              Scan
            </Link>
            <Link className="buttonLink" to="/liste">
              Liste
            </Link>
          </div>
        </div>
      )}

      {status === 'ready' && products.length > 0 && (
        <div className="productList" aria-label="Produits mémorisés">
          {products.map((product) => (
            <article className="productCard" key={product.id}>
              {editingProduct?.id === product.id ? (
                <>
                  <h3>Modifier {product.name}</h3>
                  <ProductForm
                    values={editValues}
                    errors={editErrors}
                    idPrefix={`edit-product-${product.id}`}
                    submitLabel="Enregistrer"
                    onChange={setEditValues}
                    onSubmit={handleUpdateProduct}
                    onCancel={() => {
                      setEditingProduct(null);
                      setEditErrors({});
                    }}
                  />
                </>
              ) : (
                <>
                  <div>
                    <h3>
                      {product.isFavorite && (
                        <span aria-hidden="true" title="Favori">
                          ★{' '}
                        </span>
                      )}
                      {product.name}
                    </h3>
                    <p>{product.brand ?? 'Marque non renseignée'}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>Unité</dt>
                      <dd>{product.comparisonUnit}</dd>
                    </div>
                    <div>
                      <dt>Code</dt>
                      <dd>{product.barcode ?? 'Absent'}</dd>
                    </div>
                  </dl>
                  <div className="cardActions">
                    <button
                      className="secondaryButton"
                      type="button"
                      onClick={() => handleAddToList(product)}
                    >
                      Ajouter à ma liste
                    </button>
                    <button
                      className={product.isFavorite ? 'secondaryButton successButton' : 'secondaryButton'}
                      type="button"
                      onClick={() => handleToggleFavorite(product)}
                    >
                      {product.isFavorite ? '★ Favori' : '☆ Marquer favori'}
                    </button>
                    <button
                      className="secondaryButton"
                      type="button"
                      onClick={() => {
                        setEditingProduct(product);
                        setEditValues(productToForm(product));
                        setEditErrors({});
                      }}
                    >
                      Modifier
                    </button>
                    <button
                      className="dangerButton"
                      type="button"
                      onClick={() => handleDeleteProduct(product)}
                    >
                      Supprimer
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function sortByFavoriteThenName(products: Product[]) {
  return [...products].sort((a, b) => {
    if (Boolean(a.isFavorite) !== Boolean(b.isFavorite)) {
      return a.isFavorite ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'fr');
  });
}
