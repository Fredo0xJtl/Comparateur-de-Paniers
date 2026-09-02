import { useEffect, useState } from 'react';
import { listProducts } from '../db/seed';
import { ProductForm } from '../features/products/ProductForm';
import {
  createProduct,
  deleteProduct,
  emptyProductForm,
  markProductUsed,
  productToForm,
  updateProduct,
  type ProductFormErrors,
  type ProductFormValues
} from '../features/products/productService';
import { addProductToActiveList } from '../features/shopping-list/shoppingListService';
import { type Product } from '../types/domain';

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [formValues, setFormValues] = useState<ProductFormValues>(emptyProductForm);
  const [formErrors, setFormErrors] = useState<ProductFormErrors>({});
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

  async function refreshProducts() {
    setProducts(await listProducts());
    setStatus('ready');
  }

  async function handleCreateProduct() {
    const result = await createProduct(formValues);
    setFormErrors(result.errors);
    if (!result.isValid) {
      return;
    }
    setFormValues(emptyProductForm);
    setMessage('Produit ajouté localement.');
    await refreshProducts();
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

  return (
    <section className="pageStack" aria-labelledby="products-title">
      <div className="settingsPanel">
        <h3>Ajouter un produit</h3>
        <ProductForm
          values={formValues}
          errors={formErrors}
          idPrefix="new-product"
          submitLabel="Ajouter"
          onChange={setFormValues}
          onSubmit={handleCreateProduct}
        />
      </div>

      <div>
        <h2 id="products-title">Produits mémorisés</h2>
      </div>

      {message && <p className="panelText">{message}</p>}

      {status === 'loading' && <p className="panelText">Chargement des produits locaux...</p>}
      {status === 'error' && (
        <p className="panelText panelTextDanger">Impossible de charger la base locale.</p>
      )}

      {status === 'ready' && (
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
                    <h3>{product.name}</h3>
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
