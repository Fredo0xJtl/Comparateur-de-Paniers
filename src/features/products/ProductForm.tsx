import {
  comparisonUnitOptions,
  type ProductFormErrors,
  type ProductFormValues
} from './productService';

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

      <label>
        <span>Marque</span>
        <input
          id={fieldId('brand')}
          name="brand"
          value={values.brand}
          onChange={(event) => onChange({ ...values, brand: event.target.value })}
        />
      </label>

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

      <label>
        <span>Catégorie</span>
        <input
          id={fieldId('category')}
          name="category"
          value={values.category}
          onChange={(event) => onChange({ ...values, category: event.target.value })}
        />
      </label>

      <label>
        <span>Variante</span>
        <input
          id={fieldId('variant')}
          name="variant"
          value={values.variant}
          onChange={(event) => onChange({ ...values, variant: event.target.value })}
        />
      </label>

      <label>
        <span>Unité de comparaison</span>
        <select
          id={fieldId('comparisonUnit')}
          name="comparisonUnit"
          value={values.comparisonUnit}
          onChange={(event) => onChange({ ...values, comparisonUnit: event.target.value })}
          aria-invalid={Boolean(errors.comparisonUnit)}
        >
          {comparisonUnitOptions.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
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
        <span>Formats différents acceptés</span>
      </label>

      <label className="checkboxLabel">
        <input
          id={fieldId('allowPrivateLabel')}
          name="allowPrivateLabel"
          type="checkbox"
          checked={values.allowPrivateLabel}
          onChange={(event) => onChange({ ...values, allowPrivateLabel: event.target.checked })}
        />
        <span>Marques distributeur acceptées</span>
      </label>

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
