import {
  comparisonUnitOptions,
  type ProductFormErrors,
  type ProductFormValues
} from './productService';

const comparisonUnitLabels: Record<string, string> = {
  unit: 'à la pièce',
  liter: 'au litre',
  kilogram: 'au kilo',
  wash: 'au lavage',
  roll: 'au rouleau',
  capsule: 'à la capsule'
};

type ProductFormProps = {
  values: ProductFormValues;
  errors: ProductFormErrors;
  idPrefix: string;
  submitLabel: string;
  onChange: (values: ProductFormValues) => void;
  onSubmit: () => void;
  onCancel?: () => void;
};

export function ProductForm({
  values,
  errors,
  idPrefix,
  submitLabel,
  onChange,
  onSubmit,
  onCancel
}: ProductFormProps) {
  const fieldId = (name: keyof ProductFormValues) => `${idPrefix}-${name}`;

  return (
    <form
      className="productForm"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label>
        <span>Nom</span>
        <input
          id={fieldId('name')}
          name="name"
          value={values.name}
          onChange={(event) => onChange({ ...values, name: event.target.value })}
          aria-invalid={Boolean(errors.name)}
        />
        {errors.name && <small>{errors.name}</small>}
      </label>
      <p className="panelText">Obligatoire. Exemple : lait demi-écrémé 1 L.</p>

      <label>
        <span>Marque</span>
        <input
          id={fieldId('brand')}
          name="brand"
          value={values.brand}
          onChange={(event) => onChange({ ...values, brand: event.target.value })}
        />
      </label>
      <p className="panelText">Facultatif. Exemple : Lactel.</p>

      <label>
        <span>Code-barres</span>
        <input
          id={fieldId('barcode')}
          name="barcode"
          inputMode="numeric"
          value={values.barcode}
          onChange={(event) => onChange({ ...values, barcode: event.target.value })}
          aria-invalid={Boolean(errors.barcode)}
        />
        {errors.barcode && <small>{errors.barcode}</small>}
      </label>
      <p className="panelText">
        Facultatif. Les chiffres sous les barres du produit : ils servent à le retrouver plus vite.
      </p>

      <details className="storeUrlDetails" open={errors.comparisonUnit ? true : undefined}>
        <summary>Plus de précisions (facultatif)</summary>
        <div className="productForm">
        <label>
          <span>Catégorie (ex. lait, boissons, entretien)</span>
          <input
            id={fieldId('category')}
            name="category"
            value={values.category}
            onChange={(event) => onChange({ ...values, category: event.target.value })}
          />
        </label>

        <label>
          <span>Précision (ex. demi-sel, bio, sans lactose)</span>
          <input
            id={fieldId('variant')}
            name="variant"
            value={values.variant}
            onChange={(event) => onChange({ ...values, variant: event.target.value })}
          />
        </label>

        <label>
          <span>Comparer les prix…</span>
          <select
            id={fieldId('comparisonUnit')}
            name="comparisonUnit"
            value={values.comparisonUnit}
            onChange={(event) => onChange({ ...values, comparisonUnit: event.target.value })}
            aria-invalid={Boolean(errors.comparisonUnit)}
          >
            {comparisonUnitOptions.map((unit) => (
              <option key={unit} value={unit}>
                {comparisonUnitLabels[unit] ?? unit}
              </option>
            ))}
          </select>
          {errors.comparisonUnit && <small>{errors.comparisonUnit}</small>}
        </label>

        <label className="checkboxLabel">
          <input
            id={fieldId('allowDifferentFormat')}
            name="allowDifferentFormat"
            type="checkbox"
            checked={values.allowDifferentFormat}
            onChange={(event) =>
              onChange({ ...values, allowDifferentFormat: event.target.checked })
            }
          />
          <span>Accepter un autre format (ex. 500 g au lieu de 250 g)</span>
        </label>

        <label className="checkboxLabel">
          <input
            id={fieldId('allowPrivateLabel')}
            name="allowPrivateLabel"
            type="checkbox"
            checked={values.allowPrivateLabel}
            onChange={(event) => onChange({ ...values, allowPrivateLabel: event.target.checked })}
          />
          <span>Accepter la marque du magasin (ex. Marque Repère, U)</span>
        </label>
        </div>
      </details>

      <div className="formActions">
        <button className="primaryButton" type="submit">
          {submitLabel}
        </button>
        {onCancel && (
          <button className="secondaryButton" type="button" onClick={onCancel}>
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}
