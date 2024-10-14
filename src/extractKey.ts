/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Operation } from '@apollo/client/core';
import { createOperation } from '@apollo/client/link/utils';
import {
  checkDocument,
  cloneDeep,
  getOperationDefinition,
} from '@apollo/client/utilities';
import {
  ArgumentNode,
  DirectiveNode,
  DocumentNode,
  FragmentDefinitionNode,
  ListValueNode,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
  ValueNode,
  VariableNode,
} from 'graphql';

const DIRECTIVE_NAME = 'serialize';

type DocumentCache = Map<DocumentNode, { doc: DocumentNode; args: ListValueNode }>;

const documentCache: DocumentCache = new Map();
function extractDirectiveArguments(
  doc: DocumentNode,
  cache: DocumentCache = documentCache
): { doc: DocumentNode; args?: ListValueNode } {
  if (cache.has(doc)) {
    // We cache the transformed document to avoid re-parsing and transforming the same document
    // over and over again. The cache relies on referential equality between documents. If using
    // graphql-tag this is a given, so it should work out of the box in most cases.
    return cache.get(doc) as any;
  }

  checkDocument(doc);

  const directive = extractDirective(getOperationDefinition(doc)!, DIRECTIVE_NAME);
  if (!directive) {
    return { doc };
  }
  const argument = directive.arguments?.find((d) => d.name.value === 'key');
  if (!argument) {
    throw new Error(`The @${DIRECTIVE_NAME} directive requires a 'key' argument`);
  }
  if (argument.value.kind !== 'ListValue') {
    throw new Error(
      `The @${DIRECTIVE_NAME} directive's 'key' argument must be of type List, got ${argument.kind}`
    );
  }

  const ret = {
    doc: removeDirectiveFromDocument(doc, directive),
    args: argument.value,
  };
  cache.set(doc, ret);
  return ret;
}

export function extractKey(
  operation: Operation,
  joinDirectiveAndContext = false
): {
  operation: Operation;
  key?: string;
} {
  const keys: string[] = [];
  const { serializationKey } = operation.getContext();
  if (serializationKey) {
    if (!joinDirectiveAndContext) {
      return { operation, key: serializationKey };
    } else {
      keys.push(serializationKey);
    }
  }

  const { doc, args } = extractDirectiveArguments(operation.query);

  if (!args) {
    const key = keys.join('-');
    if (key.length > 0) {
      return { operation, key };
    } else {
      return { operation };
    }
  }

  keys.push(materializeKey(args, operation.variables));

  // Pass through the operation, with the directive removed so that the server
  // doesn't see it.
  // We also remove any arguments from the operation definition that are unused
  // after the removal of the directive.
  const newOperation = createOperation(operation.getContext(), {
    ...(operation as any),
    query: doc,
  });

  return { operation: newOperation, key: keys.join('-') };
}

function extractDirective(
  query: OperationDefinitionNode,
  directiveName: string
): DirectiveNode | undefined {
  return query.directives?.filter((node) => node.name.value === directiveName)[0];
}

export function materializeKey(
  argumentList: ListValueNode,
  variables?: Record<string, any>
): string {
  return JSON.stringify(
    argumentList.values.map((val) => valueForArgument(val, variables))
  );
}

export function valueForArgument(
  value: ValueNode,
  variables?: Record<string, any>
): string | number | boolean {
  if (value.kind === 'Variable') {
    return getVariableOrDie(variables, value.name.value);
  }
  if (value.kind === 'IntValue') {
    return parseInt(value.value, 10);
  }
  if (value.kind === 'FloatValue') {
    return parseFloat(value.value);
  }
  if (
    value.kind === 'StringValue' ||
    value.kind === 'BooleanValue' ||
    value.kind === 'EnumValue'
  ) {
    return value.value;
  }
  throw new Error(
    `Argument of type ${value.kind} is not allowed in @${DIRECTIVE_NAME} directive`
  );
}

export function getVariableOrDie(
  variables: Record<string, any> | undefined,
  name: string
): any {
  if (!variables || !(name in variables)) {
    throw new Error(`No value supplied for variable $${name} used in @serialize key`);
  }
  return variables[name];
}

// apollo-utilities removeDirectivesFromDocument currently doesn't remove them properly,
// so we do it ourselves here.
export function removeDirectiveFromDocument(
  doc: DocumentNode,
  directive?: DirectiveNode
): DocumentNode {
  if (!directive) {
    return doc;
  }

  const docWithoutDirective = cloneDeep(doc);
  const originalOperationDefinition = getOperationDefinition(doc);
  const operationDefinition = getOperationDefinition(docWithoutDirective);
  //@ts-expect-error Assigning to read-only property
  operationDefinition.directives = originalOperationDefinition?.directives?.filter(
    (node) => node !== directive
  );

  const removedVariableNames = getVariablesFromArguments(directive.arguments).map(
    (v) => v.name.value
  );

  // Sometimes the serialization key is a variable that isn't used for anything else in the query.
  // In that case we need to remove the variable definition from the document to maintain its validity
  // when removing the @serialize directive.
  removeVariableDefinitionsFromDocumentIfUnused(
    removedVariableNames,
    docWithoutDirective
  );

  return docWithoutDirective;
}

export function getAllArgumentsFromSelectionSet(
  selectionSet?: SelectionSetNode
): readonly ArgumentNode[] {
  if (!selectionSet) {
    return [];
  }
  return selectionSet.selections
    .map(getAllArgumentsFromSelection)
    .reduce((allArguments, selectionArguments) => {
      return [...allArguments, ...selectionArguments];
    }, []);
}

export function getAllArgumentsFromSelection(
  selection: SelectionNode
): readonly ArgumentNode[] {
  if (!selection) {
    return [];
  }

  let args = getAllArgumentsFromDirectives(selection.directives);
  if (selection.kind === 'Field') {
    args = args.concat(selection.arguments || []);
    args = args.concat(getAllArgumentsFromSelectionSet(selection.selectionSet));
  }
  return args;
}

export function getAllArgumentsFromDirectives(
  directives?: readonly DirectiveNode[]
): readonly ArgumentNode[] {
  return (
    directives
      ?.map((d) => d.arguments || [])
      .reduce((allArguments, directiveArguments) => {
        return [...allArguments, ...directiveArguments];
      }, []) ?? []
  );
}

export function getAllArgumentsFromDocument(doc: DocumentNode): ArgumentNode[] {
  return doc.definitions
    .map((def) => {
      if (def.kind === 'FragmentDefinition') {
        return getAllArgumentsFromFragment(def);
      } else if (def.kind === 'OperationDefinition') {
        return getAllArgumentsFromOperation(def);
      } else {
        return [];
      }
    })
    .reduce((allArguments, definitionArguments) => {
      return [...allArguments, ...definitionArguments];
    }, []);
}

export function getAllArgumentsFromOperation(
  op: OperationDefinitionNode
): ArgumentNode[] {
  return getAllArgumentsFromDirectives(op.directives).concat(
    getAllArgumentsFromSelectionSet(op.selectionSet)
  );
}

export function getAllArgumentsFromFragment(
  frag: FragmentDefinitionNode
): ArgumentNode[] {
  return getAllArgumentsFromDirectives(frag.directives).concat(
    getAllArgumentsFromSelectionSet(frag.selectionSet)
  );
}

export function getVariablesFromArguments(
  args: readonly ArgumentNode[] | undefined
): VariableNode[] {
  return (
    args
      ?.map((arg) => getVariablesFromValueNode(arg.value))
      .reduce((a, b) => a.concat(b), []) ?? []
  );
}

export function getVariablesFromValueNode(node: ValueNode): VariableNode[] {
  switch (node.kind) {
    case 'Variable':
      return [node];

    case 'ListValue':
      return node.values.map(getVariablesFromValueNode).reduce((a, b) => a.concat(b), []);

    case 'ObjectValue':
      return node.fields
        .map((f) => f.value)
        .map(getVariablesFromValueNode)
        .reduce((a, b) => a.concat(b), []);

    default:
      return [];
  }
}

// Warning: This function may modify the document in place
export function removeVariableDefinitionsFromDocumentIfUnused(
  names: string[],
  doc: DocumentNode
): void {
  if (names.length < 1) {
    return;
  }

  const args = getAllArgumentsFromDocument(doc);
  const usedNames = new Set(getVariablesFromArguments(args).map((v) => v.name.value));

  const filteredNames = new Set(names.filter((name) => !usedNames.has(name)));
  if (filteredNames.size < 1) {
    return;
  }

  const op = getOperationDefinition(doc);
  if (op?.variableDefinitions) {
    //@ts-expect-error Assigning to read-only property
    op.variableDefinitions = op.variableDefinitions.filter(
      (d) => !filteredNames.has(d.variable.name.value)
    );
  }
}
