export interface Label {
    id: string
    /** name of the label */
    name?: string
    /** color of label */
    color?: number
    /** predefined id of label */
    predefinedId?: number
    /** flag of deleted label */
    deleted?: boolean
}
